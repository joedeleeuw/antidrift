use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-compat-names";

#[must_use]
pub fn is_compat_name(name: &str) -> bool {
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
    scope: RuleScope,
}

impl NoCompatNames {
    pub const DEFAULT: Self = Self {
        scope: RuleScope::DEFAULT,
    };
}

pub static DEFAULT_INSTANCE: NoCompatNames = NoCompatNames::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(NoCompatNames {
        scope: RuleScope::from_options(RULE_NAME, options)?,
    }))
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
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = self.scope.matches(ctx.file.file_name(), cwd);
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
