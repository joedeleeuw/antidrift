use antidrift_kernel::{shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

use super::erasure_analysis::{
    classify_widening_target, erased_unknown_source, has_laundered_unknown_use,
    is_const_declaration, is_empty_container_literal, is_known_value_expression,
    is_mutated_object_binding, is_populated_case_table_object, is_widened_known_declaration,
    skip_parentheses_up,
};

fn check_case_table_annotation(
    ctx: &mut Ctx,
    decl_node: P<Node>,
    name_node: P<Node>,
    type_node: P<Node>,
    init: P<Node>,
) -> bool {
    if !is_populated_case_table_object(init) {
        return false;
    }
    let Some(kind) = shape::classify_closed_case_table_annotation(ctx.checker, type_node) else {
        return false;
    };
    let Some(sym) = ctx.checker.get_symbol_at_location_exported(name_node) else {
        return false;
    };
    let scope_root = tsrs_kernel::enclosing_function(decl_node).unwrap_or(ctx.file.as_node());
    if is_mutated_object_binding(ctx.checker, scope_root, sym) {
        return false;
    }
    let name = name_node.as_identifier().text();
    ctx.report_node(
        type_node,
        RuleMessage::new(
            "caseTableAnnotation",
            format!(
                "Annotating case table \"{name}\" with a {kind} widens its per-key entry types and erases literal evidence. Remove the variable type annotation and validate with `satisfies` (`const {name} = {{ ... }} satisfies ...`) instead."
            ),
        ),
    );
    true
}

fn check_appeasement_erasure_variable(
    ctx: &mut Ctx,
    decl_node: P<Node>,
    name_node: P<Node>,
    type_node: Option<P<Node>>,
    init: P<Node>,
) -> bool {
    let Some(source_expr) = erased_unknown_source(type_node, init) else {
        return false;
    };
    if is_empty_container_literal(source_expr) {
        return false;
    }
    let source_type = ctx.checker.get_type_at_location(source_expr);
    if !shape::is_specific_type(source_type) {
        return false;
    }
    let Some(sym) = ctx.checker.get_symbol_at_location_exported(name_node) else {
        return false;
    };
    let scope_root = tsrs_kernel::enclosing_function(decl_node).unwrap_or(ctx.file.as_node());
    if !has_laundered_unknown_use(ctx.checker, scope_root, sym, name_node) {
        return false;
    }
    ctx.report_node(
        name_node,
        RuleMessage::new(
            "appeasementErasure",
            "Appeasement erasure: this value already has a known type, and widening it to unknown only makes the parse or cast below look earned. Keep the compiler's type and validate at the real boundary instead.",
        ),
    );
    true
}

fn report_widening(ctx: &mut Ctx, node: P<Node>, target: &str, subject: &str) {
    let msg = format!(
        "The explicit {target} type on {subject} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract."
    );
    ctx.report_node(node, RuleMessage::new("widening", msg));
}

fn check_variable_declaration(ctx: &mut Ctx, node: P<Node>) {
    let decl = node.as_variable_declaration();
    let name_node = decl.name();
    let Some(init) = decl.initializer() else {
        return;
    };
    if is_const_declaration(node)
        && ast::is_identifier(name_node)
        && (decl
            .type_()
            .is_some_and(|t| check_case_table_annotation(ctx, node, name_node, t, init))
            || check_appeasement_erasure_variable(ctx, node, name_node, decl.type_(), init))
    {
        return;
    }
    let Some(type_node) = decl.type_() else {
        return;
    };
    let Some(target) = classify_widening_target(type_node) else {
        return;
    };
    if is_known_value_expression(ctx.checker, init) {
        let subject = if ast::is_identifier(name_node) {
            format!("variable \"{}\"", name_node.as_identifier().text())
        } else {
            "variable".to_owned()
        };
        report_widening(ctx, type_node, target, &subject);
    }
}

fn check_binary_expression(ctx: &mut Ctx, node: P<Node>) {
    let bin = node.as_binary_expression();
    let left = tsrs_kernel::unwrap_parentheses(bin.left());
    if bin.operator_token().kind() != Kind::EqualsToken
        || !ast::is_identifier(left)
        || !is_known_value_expression(ctx.checker, bin.right())
    {
        return;
    }
    let Some(decl) = ctx
        .checker
        .get_symbol_at_location_exported(left)
        .and_then(|sym| sym.value_declaration())
    else {
        return;
    };
    if decl.kind() != Kind::VariableDeclaration {
        return;
    }
    let vd = decl.as_variable_declaration();
    if vd.initializer().is_none()
        && let Some(target) = vd.type_().and_then(classify_widening_target)
    {
        let subject = format!("assignment to \"{}\"", left.as_identifier().text());
        report_widening(ctx, node, target, &subject);
    }
}

fn extract_root_ident(operand: P<Node>) -> Option<P<Node>> {
    let unwrapped = tsrs_kernel::unwrap_parentheses(operand);
    match unwrapped.kind() {
        Kind::Identifier => Some(unwrapped),
        Kind::PropertyAccessExpression => {
            let obj = tsrs_kernel::unwrap_parentheses(
                unwrapped.as_property_access_expression().expression(),
            );
            ast::is_identifier(obj).then_some(obj)
        }
        Kind::ElementAccessExpression => {
            let obj = tsrs_kernel::unwrap_parentheses(
                unwrapped.as_element_access_expression().expression(),
            );
            ast::is_identifier(obj).then_some(obj)
        }
        _ => None,
    }
}

fn check_widen_then_assert(ctx: &mut Ctx, node: P<Node>, operand: P<Node>, type_node: P<Node>) {
    if matches!(type_node.kind(), Kind::AnyKeyword | Kind::UnknownKeyword)
        || tsrs_kernel::is_const_assertion(type_node)
    {
        return;
    }
    let Some(ident) = extract_root_ident(operand) else {
        return;
    };
    let Some(decl) = ctx
        .checker
        .get_symbol_at_location_exported(ident)
        .and_then(|sym| sym.value_declaration())
    else {
        return;
    };
    if decl.kind() != Kind::VariableDeclaration
        || !is_const_declaration(decl)
        || tsrs_kernel::enclosing_function(decl) != tsrs_kernel::enclosing_function(node)
        || !is_widened_known_declaration(ctx.checker, decl)
    {
        return;
    }
    let name = ident.as_identifier().text();
    ctx.report_node(
        node,
        RuleMessage::new(
            "widenThenAssert",
            format!(
                "Binding \"{name}\" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once."
            ),
        ),
    );
}

fn is_laundered_unknown_initializer(ctx: &mut Ctx, node: P<Node>, type_node: P<Node>) -> bool {
    if type_node.kind() != Kind::UnknownKeyword {
        return false;
    }
    let Some(parent) = skip_parentheses_up(node) else {
        return false;
    };
    if parent.kind() != Kind::VariableDeclaration || !is_const_declaration(parent) {
        return false;
    }
    let decl = parent.as_variable_declaration();
    if decl.initializer().map(tsrs_kernel::unwrap_parentheses) != Some(node) {
        return false;
    }
    let name_node = decl.name();
    if !ast::is_identifier(name_node) {
        return false;
    }
    let Some(sym) = ctx.checker.get_symbol_at_location_exported(name_node) else {
        return false;
    };
    let scope_root = tsrs_kernel::enclosing_function(parent).unwrap_or(ctx.file.as_node());
    has_laundered_unknown_use(ctx.checker, scope_root, sym, name_node)
}

fn check_assertion(ctx: &mut Ctx, node: P<Node>) {
    let Some((operand, type_node)) = tsrs_kernel::assertion_parts(node) else {
        return;
    };
    if is_laundered_unknown_initializer(ctx, node, type_node) {
        return;
    }
    if let Some(target) = classify_widening_target(type_node) {
        let is_double_cast = skip_parentheses_up(node).is_some_and(|p| {
            matches!(p.kind(), Kind::AsExpression | Kind::TypeAssertionExpression)
        });
        if !is_double_cast && is_known_value_expression(ctx.checker, operand) {
            report_widening(ctx, node, target, "type assertion");
        }
        return;
    }
    check_widen_then_assert(ctx, node, operand, type_node);
}

pub struct NoAppeasementErasure;

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::ReturnStatement),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::AsExpression),
    Listener::Enter(Kind::TypeAssertionExpression),
];

impl Rule for NoAppeasementErasure {
    fn name(&self) -> &'static str {
        "antidrift/no-appeasement-erasure"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::VariableDeclaration => check_variable_declaration(ctx, node),
            Kind::PropertyDeclaration => {
                let prop = node.as_property_declaration();
                if let (Some(type_node), Some(init)) = (prop.type_(), prop.initializer())
                    && let Some(target) = classify_widening_target(type_node)
                    && is_known_value_expression(ctx.checker, init)
                {
                    report_widening(ctx, type_node, target, "property");
                }
            }
            Kind::BinaryExpression => check_binary_expression(ctx, node),
            Kind::ReturnStatement => {
                if let Some(expr) = node.as_return_statement().expression()
                    && let Some(ret_type) = tsrs_kernel::enclosing_function(node)
                        .and_then(tsrs_kernel::function_return_type_node)
                    && let Some(target) = classify_widening_target(ret_type)
                    && is_known_value_expression(ctx.checker, expr)
                {
                    report_widening(ctx, expr, target, "return value");
                }
            }
            Kind::ArrowFunction => {
                if let Some(body) = node.as_arrow_function().body()
                    && body.kind() != Kind::Block
                    && let Some(ret_type) = tsrs_kernel::function_return_type_node(node)
                    && let Some(target) = classify_widening_target(ret_type)
                    && is_known_value_expression(ctx.checker, body)
                {
                    report_widening(ctx, body, target, "return value");
                }
            }
            Kind::AsExpression | Kind::TypeAssertionExpression => check_assertion(ctx, node),
            _ => {}
        }
    }
}
