use antidrift_kernel::file_role::{FileRole, ProjectPath};
use antidrift_kernel::rule_options::reject_unknown_options;
use tsrs_ast::{Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-default-export-in-domain";

pub struct NoDefaultExportInDomain;

pub static DEFAULT_RULE: NoDefaultExportInDomain = NoDefaultExportInDomain;

impl NoDefaultExportInDomain {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        reject_unknown_options(RULE_NAME, options)?;
        Ok(Self)
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ExportAssignment),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
];

#[must_use]
pub fn inferred_role(path: &ProjectPath) -> bool {
    is_domain_file(path.as_str())
}

impl Rule for NoDefaultExportInDomain {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let path = ProjectPath::of(ctx.program, ctx.file.file_name());
        let enabled = !path.has_role(FileRole::TestOrSpec)
            && !is_migration_file(path.as_str())
            && !is_generated_or_declaration_module(path.as_str());
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let is_default_export = match node.kind() {
            Kind::ExportAssignment => !node.as_export_assignment().is_export_equals(),
            Kind::FunctionDeclaration | Kind::ClassDeclaration | Kind::InterfaceDeclaration => {
                node.modifier_flags().intersects(ModifierFlags::Default)
                    && node.parent().is_some_and(|p| p.kind() == Kind::SourceFile)
            }
            _ => false,
        };
        if is_default_export {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "forbidden",
                    "Default exports are banned in domain modules. Use named exports.",
                ),
            );
        }
    }
}

fn is_domain_file(filename: &str) -> bool {
    filename.starts_with("domain/")
        || filename.starts_with("model/")
        || filename.contains("/domain/")
        || filename.contains("/model/")
}

fn is_migration_file(filename: &str) -> bool {
    if filename
        .split('/')
        .any(|seg| matches!(seg, "migration" | "migrations"))
        || filename.contains("/db/migrations/")
        || filename.starts_with("db/migrations/")
    {
        return true;
    }
    let base = filename.rsplit('/').next().unwrap_or(filename);
    let digit_count = base.bytes().take_while(u8::is_ascii_digit).count();
    digit_count > 0 && matches!(base.as_bytes().get(digit_count), Some(b'_' | b'-'))
}

fn is_generated_or_declaration_module(filename: &str) -> bool {
    let base = filename.rsplit('/').next().unwrap_or(filename);
    has_middle_tag(base, &["gen", "generated", "d"])
}

fn has_middle_tag(base: &str, tags: &[&str]) -> bool {
    let Some((stem, ext)) = base.rsplit_once('.') else {
        return false;
    };
    if !matches!(
        ext,
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts"
    ) {
        return false;
    }
    let Some((_, tag)) = stem.rsplit_once('.') else {
        return false;
    };
    tags.contains(&tag)
}
