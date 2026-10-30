use super::vague_name_lexicon::{duplicate_context_word, vague_reason};
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel;
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::Type;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{is_intersection_type, is_union_type};

const RULE_NAME: &str = "antidrift/no-vague-names";

fn is_context_type_name(name: &str) -> bool {
    name.ends_with("Ctx") || name.ends_with("Context")
}

fn type_node_has_context_name(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::ParenthesizedType => {
            type_node_has_context_name(type_node.as_parenthesized_type_node().type_())
        }
        Kind::TypeReference => {
            let type_name = type_node.as_type_reference_node().type_name();
            let ident = if ast::is_qualified_name(type_name) {
                type_name.as_qualified_name().right()
            } else {
                type_name
            };
            ast::is_identifier(ident) && is_context_type_name(ident.as_identifier().text())
        }
        Kind::UnionType | Kind::IntersectionType => {
            tsrs_kernel::union_or_intersection_type_nodes(type_node)
                .iter()
                .any(|&member| type_node_has_context_name(member))
        }
        _ => false,
    }
}

fn type_has_context_symbol(typ: P<Type>) -> bool {
    if (is_union_type(typ) || is_intersection_type(typ))
        && typ
            .types()
            .iter()
            .any(|&member| type_has_context_symbol(member))
    {
        return true;
    }
    if let Some(alias) = typ.alias()
        && let Some(sym) = alias.symbol()
        && is_context_type_name(sym.name())
    {
        return true;
    }
    typ.symbol()
        .is_some_and(|sym| is_context_type_name(sym.name()))
}

fn declaration_type_node(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::Parameter => node.as_parameter_declaration().type_(),
        Kind::VariableDeclaration => node.as_variable_declaration().type_(),
        Kind::PropertyDeclaration => node.as_property_declaration().type_(),
        Kind::PropertySignature => node.as_property_signature_declaration().type_(),
        _ => tsrs_kernel::function_return_type_node(node),
    }
}

fn is_framework_context(ctx: &mut Ctx, ident: P<Node>) -> bool {
    if ident.as_identifier().text() != "ctx" {
        return false;
    }
    if let Some(parent) = ident.parent()
        && parent.name() == Some(ident)
        && let Some(type_node) = declaration_type_node(parent)
    {
        return type_node_has_context_name(type_node);
    }
    let typ = ctx.checker.get_type_at_location(ident);
    type_has_context_symbol(typ)
}

fn is_jsx_expression(node: P<Node>) -> bool {
    let expr = tsrs_kernel::unwrap_parentheses(node);
    match expr.kind() {
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment => true,
        Kind::ConditionalExpression => {
            let cond = expr.as_conditional_expression();
            is_jsx_expression(cond.when_true()) || is_jsx_expression(cond.when_false())
        }
        Kind::BinaryExpression => {
            let bin = expr.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) && is_jsx_expression(bin.right())
        }
        _ => false,
    }
}

fn is_component_function(fn_node: P<Node>) -> bool {
    tsrs_kernel::function_name(fn_node)
        .and_then(|name| name.as_bytes().first())
        .is_some_and(u8::is_ascii_uppercase)
        || tsrs_kernel::collect_return_expressions(fn_node.body())
            .into_iter()
            .any(is_jsx_expression)
}

fn check_ident(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(ident) = node else {
        return;
    };
    if !ast::is_identifier(ident) || is_framework_context(ctx, ident) {
        return;
    }
    let name = ident.as_identifier().text();
    if let Some(reason) = vague_reason(name) {
        ctx.report_node(
            ident,
            RuleMessage::new(
                "vague",
                format!("'{name}' is {reason}. Name the binding for what it holds in this domain."),
            ),
        );
    }
}

fn check_binding_node(ctx: &mut Ctx, node: Option<P<Node>>) {
    let Some(curr) = node else {
        return;
    };
    match curr.kind() {
        Kind::Identifier => check_ident(ctx, Some(curr)),
        Kind::Parameter => check_binding_node(ctx, curr.name()),
        Kind::BindingElement => {
            let is_object_shorthand = curr
                .parent()
                .is_some_and(|p| p.kind() == Kind::ObjectBindingPattern)
                && curr.as_binding_element().property_name().is_none();
            if !is_object_shorthand {
                check_binding_node(ctx, curr.name());
            }
        }
        Kind::ObjectBindingPattern | Kind::ArrayBindingPattern => {
            for &elem in curr.as_binding_pattern().elements().nodes() {
                check_binding_node(ctx, Some(elem));
            }
        }
        _ => {}
    }
}

fn check_duplicate_context(ctx: &mut Ctx, name_node: Option<P<Node>>, report_node: P<Node>) {
    let Some(target) = name_node else {
        return;
    };
    let name = if ast::is_identifier(target) {
        target.as_identifier().text()
    } else if ast::is_string_literal(target)
        && let Some(literal) = cooked_text(target)
    {
        literal
    } else {
        return;
    };
    if let Some(word) = duplicate_context_word(name) {
        ctx.report_node(
            report_node,
            RuleMessage::new(
                "duplicate",
                format!(
                    "Function '{name}' repeats '{word}'. Remove duplicate context from the identifier."
                ),
            ),
        );
    }
}

fn is_exempt_props_parameter(fn_node: P<Node>, index: usize, param: P<Node>) -> bool {
    if index != 0 {
        return false;
    }
    let param_decl = param.as_parameter_declaration();
    if param_decl.dot_dot_dot_token().is_some() || param_decl.initializer().is_some() {
        return false;
    }
    param.name().is_some_and(|name_node| {
        ast::is_identifier(name_node)
            && name_node.as_identifier().text() == "props"
            && is_component_function(fn_node)
    })
}

fn check_function(ctx: &mut Ctx, node: P<Node>) {
    if node.kind() != Kind::ArrowFunction && node.kind() != Kind::MethodDeclaration {
        check_ident(ctx, node.name());
    }
    if node.kind() == Kind::FunctionDeclaration {
        check_duplicate_context(ctx, node.name(), node);
    }
    for (idx, &param) in node.parameters().iter().enumerate() {
        if !is_exempt_props_parameter(node, idx, param) {
            check_binding_node(ctx, Some(param));
        }
    }
}

fn check_import_specifier(ctx: &mut Ctx, node: P<Node>) {
    let spec = node.as_import_specifier();
    if spec.property_name().is_none() {
        return;
    }
    let alias = spec.name();
    if !ast::is_identifier(alias) {
        return;
    }
    let name = alias.as_identifier().text();
    let reason = vague_reason(name).or_else(|| {
        (name.len() > 4 && name.ends_with("Type")).then(|| "a filler suffix".to_owned())
    });
    if let Some(reason) = reason {
        ctx.report_node(
            alias,
            RuleMessage::new(
                "vague",
                format!("'{name}' is {reason}. Name the binding for what it holds in this domain."),
            ),
        );
    }
}

pub struct NoVagueNames {
    scope: RuleScope,
}

impl NoVagueNames {
    pub const DEFAULT: Self = Self {
        scope: RuleScope::DEFAULT,
    };
}

pub static DEFAULT_INSTANCE: NoVagueNames = NoVagueNames::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(NoVagueNames {
        scope: RuleScope::from_options(RULE_NAME, options)?,
    }))
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
    Listener::Enter(Kind::CatchClause),
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::ImportSpecifier),
];

impl Rule for NoVagueNames {
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
            Listener::Enter(Kind::VariableDeclaration) => {
                let var_decl = node.as_variable_declaration();
                let name_node = var_decl.name();
                check_binding_node(ctx, Some(name_node));
                if let Some(init) = var_decl.initializer()
                    && matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                {
                    check_duplicate_context(ctx, Some(name_node), node);
                }
            }
            Listener::Enter(
                Kind::FunctionDeclaration
                | Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                check_function(ctx, node);
            }
            Listener::Enter(Kind::MethodDeclaration) => {
                check_duplicate_context(ctx, node.name(), node);
                check_function(ctx, node);
            }
            Listener::Enter(Kind::CatchClause) => {
                if let Some(var_decl) = node.as_catch_clause().variable_declaration() {
                    check_binding_node(ctx, var_decl.name());
                }
            }
            Listener::Enter(
                Kind::ClassDeclaration | Kind::TypeAliasDeclaration | Kind::InterfaceDeclaration,
            ) => {
                check_ident(ctx, node.name());
            }
            Listener::Enter(Kind::ImportSpecifier) => {
                check_import_specifier(ctx, node);
            }
            _ => {}
        }
    }
}
