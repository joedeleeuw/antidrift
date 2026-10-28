use antidrift_kernel::{provenance, rule_scope, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor, options_object};

fn extract_patterns(options: Option<&serde_json::Value>, key: &str) -> Vec<String> {
    let map = options_object(options);
    let Some(arr) = map.get(key).and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn matches_scope(file_name: &str, cwd: &str, files: &[String], exclude_files: &[String]) -> bool {
    let normalized = tsrs_kernel::normalize_path(file_name);
    let local = provenance::relative_to_cwd(cwd, &normalized);
    let matches_any = |patterns: &[String]| {
        patterns.iter().any(|pattern| {
            rule_scope::glob_matches(&local, pattern)
                || rule_scope::glob_matches(&normalized, pattern)
        })
    };
    (files.is_empty() || matches_any(files)) && !matches_any(exclude_files)
}

fn is_compat_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.contains("legacy")
        || lower.contains("deprecated")
        || lower.contains("retire")
        || lower.contains("nolonger")
        || lower.contains("no_longer")
    {
        return true;
    }
    let mut search_from = 0usize;
    while let Some(offset) = lower[search_from..].find("compat") {
        let abs = search_from + offset;
        if !lower[abs..].starts_with("compatible") {
            return true;
        }
        search_from = abs + 6;
    }
    false
}

fn build_compat_message(name: &str) -> RuleMessage {
    RuleMessage::new(
        "compatName",
        format!(
            "'{name}' declares a compatibility or retirement path. Delete the old path instead of keeping or naming it."
        ),
    )
}

fn check_ident(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(ident) = node else {
        return;
    };
    if !ast::is_identifier(ident) {
        return;
    }
    let text = ident.as_identifier().text();
    if is_compat_name(text) {
        ctx.report_node(ident, build_compat_message(text));
    }
}

fn check_binding_node(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(curr) = node else {
        return;
    };
    match curr.kind() {
        Kind::Identifier => check_ident(ctx, Some(curr)),
        Kind::Parameter | Kind::BindingElement => check_binding_node(ctx, curr.name()),
        Kind::ObjectBindingPattern | Kind::ArrayBindingPattern => {
            for &elem in curr.as_binding_pattern().elements().nodes() {
                check_binding_node(ctx, Some(elem));
            }
        }
        _ => {}
    }
}

fn check_parameters(ctx: &mut Ctx, node: P<Node>) {
    for &param in node.parameters() {
        check_binding_node(ctx, Some(param));
    }
}

pub struct NoCompatNames {
    files: Vec<String>,
    exclude_files: Vec<String>,
}

impl NoCompatNames {
    pub const DEFAULT: Self = Self {
        files: Vec::new(),
        exclude_files: Vec::new(),
    };
}

pub static DEFAULT_INSTANCE: NoCompatNames = NoCompatNames::DEFAULT;

#[must_use]
pub fn create(options: Option<&serde_json::Value>) -> Box<dyn Rule> {
    Box::new(NoCompatNames {
        files: extract_patterns(options, "files"),
        exclude_files: extract_patterns(options, "excludeFiles"),
    })
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertySignature),
];

impl Rule for NoCompatNames {
    fn name(&self) -> &'static str {
        "antidrift/no-compat-names"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = matches_scope(ctx.file.file_name(), cwd, &self.files, &self.exclude_files);
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

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(Kind::FunctionDeclaration | Kind::MethodDeclaration) => {
                check_ident(ctx, node.name());
                check_parameters(ctx, node);
            }
            Listener::Enter(
                Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                check_parameters(ctx, node);
            }
            Listener::Enter(Kind::VariableDeclaration) => {
                check_binding_node(ctx, node.name());
            }
            Listener::Enter(
                Kind::ClassDeclaration
                | Kind::InterfaceDeclaration
                | Kind::TypeAliasDeclaration
                | Kind::PropertyDeclaration
                | Kind::PropertySignature,
            ) => {
                check_ident(ctx, node.name());
            }
            _ => {}
        }
    }
}
