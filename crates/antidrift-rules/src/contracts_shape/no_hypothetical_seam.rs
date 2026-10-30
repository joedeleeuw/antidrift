use super::test_only_seam::check_test_only_seams;
use antidrift_kernel::callgraph::ProgramSymbolIndex;
use antidrift_kernel::file_role;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-hypothetical-seam";

const EFFECTFUL_NAMES: &[&str] = &[
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fetch",
    "setTimeout",
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
];

const EFFECTFUL_MEMBERS: &[(&str, &str)] = &[
    ("Date", "now"),
    ("performance", "now"),
    ("crypto", "randomUUID"),
    ("Math", "random"),
];

pub struct NoHypotheticalSeam {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoHypotheticalSeam = NoHypotheticalSeam {
    scope: RuleScope::DEFAULT,
};

impl NoHypotheticalSeam {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
];

impl Rule for NoHypotheticalSeam {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.admits_authored_source(ctx) {
            return Box::new(EmptyVisitor);
        }
        match provenance::is_package_entry_file(ctx.file.file_name()) {
            Ok(true) => return Box::new(EmptyVisitor),
            Ok(false) => {}
            Err(error) => {
                ctx.report_node(
                    ctx.file.as_node(),
                    RuleMessage::new("invalidPackageJson", error.to_string()),
                );
                return Box::new(EmptyVisitor);
            }
        }
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(Kind::ClassDeclaration) => {
                if ast::has_syntactic_modifier(node, ModifierFlags::Abstract) {
                    check_single_adapter_seam(ctx, node);
                }
            }
            Listener::Enter(Kind::InterfaceDeclaration) => check_single_adapter_seam(ctx, node),
            Listener::Enter(
                Kind::FunctionDeclaration | Kind::MethodDeclaration | Kind::Constructor,
            ) => {
                check_test_only_seams(ctx, node);
            }
            _ => {}
        }
    }
}

pub(super) fn identifier_name(node: Option<P<Node>>) -> Option<(P<Node>, &'static str)> {
    node.filter(|name| ast::is_identifier(*name))
        .map(|name| (name, name.as_identifier().text()))
}

fn check_single_adapter_seam(ctx: &mut Ctx, node: P<Node>) {
    let Some((name_node, name)) = identifier_name(node.name()) else {
        return;
    };
    let Some(seam) = provenance::symbol_at_node(ctx.checker, name_node) else {
        return;
    };
    let index = ProgramSymbolIndex::for_program(ctx.program);
    let summary = index.adapter_counts_for_seam(ctx.checker, seam, name);
    if summary.has_class_implements && summary.prod_adapters == 1 && summary.test_adapters == 0 {
        ctx.report_node(
            name_node,
            RuleMessage::new(
                "singleAdapterSeam",
                format!(
                    "'{name}' is a seam with exactly one production adapter and no test adapter. Delete '{name}' and depend on the adapter directly until a second adapter exists."
                ),
            ),
        );
    }
}

fn is_first_party_function_declaration(program: &Program, decl: P<Node>) -> bool {
    let Some(sf) = ast::get_source_file_of_node(decl) else {
        return false;
    };
    if file_role::is_declaration_file(sf.file_name())
        || program.is_source_file_from_external_library(sf)
    {
        return false;
    }
    match decl.kind() {
        Kind::FunctionDeclaration => true,
        Kind::VariableDeclaration => {
            let is_module_scope = decl
                .parent()
                .and_then(|list| list.parent())
                .and_then(|stmt| stmt.parent())
                .is_some_and(ast::is_source_file);
            is_module_scope
                && tsrs_kernel::function_node_from_declaration(decl).is_some_and(|func| {
                    matches!(func.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                })
        }
        _ => false,
    }
}

pub(super) fn is_effectful_default(ctx: &mut Ctx, default_expr: P<Node>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(default_expr);
    if inner.kind() == Kind::PropertyAccessExpression {
        let Some((root, members)) = tsrs_kernel::static_member_chain(inner) else {
            return false;
        };
        let root_name = ast::is_identifier(root).then(|| root.as_identifier().text());
        return EFFECTFUL_MEMBERS
            .iter()
            .any(|&(owner, member)| root_name == Some(owner) && members == [member])
            || members
                .last()
                .is_some_and(|member| EFFECTFUL_NAMES.contains(member));
    }
    if !ast::is_identifier(inner) {
        return false;
    }
    let text = inner.as_identifier().text();
    if EFFECTFUL_NAMES.contains(&text) {
        return true;
    }
    if text.starts_with(|first: char| first.is_ascii_uppercase()) {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(ctx.checker, inner) else {
        return false;
    };
    symbol
        .value_declaration()
        .is_some_and(|decl| is_first_party_function_declaration(ctx.program, decl))
}
