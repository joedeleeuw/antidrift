use tsrs_ast::{
    self as ast, ArrayLiteralExpression, Kind, Node, ObjectLiteralExpression, TemplateExpression,
};
use tsrs_core::P;

use crate::tsrs_kernel;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DelegatedCallCandidate {
    pub declaration: P<Node>,
    pub function_node: P<Node>,
    pub name_node: P<Node>,
    pub call_node: P<Node>,
    pub callee_node: P<Node>,
}

fn is_simple_callee(node: P<Node>) -> bool {
    if ast::is_identifier(node) {
        return true;
    }
    if ast::is_property_access_expression(node) {
        let prop_access = node.as_property_access_expression();
        if prop_access.question_dot_token().is_some() {
            return false;
        }
        let expr = prop_access.expression();
        return is_simple_callee(expr) || is_composed_call(expr);
    }
    false
}

fn is_composed_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let call = node.as_call_expression();
    if call.question_dot_token().is_some()
        || call.type_arguments().is_some()
        || !is_simple_callee(call.expression())
    {
        return false;
    }
    call.arguments()
        .nodes()
        .iter()
        .all(|&arg| is_forwarded_arg(arg))
}

fn is_forwarded_template(node: &TemplateExpression) -> bool {
    node.template_spans()
        .nodes()
        .iter()
        .all(|&span| is_forwarded_arg(span.as_template_span().expression()))
}

fn is_forwarded_object_property(prop: P<Node>) -> bool {
    match prop.kind() {
        Kind::SpreadAssignment => is_forwarded_arg(prop.as_spread_assignment().expression()),
        Kind::PropertyAssignment => {
            let prop_assign = prop.as_property_assignment();
            prop_assign.name().kind() != Kind::ComputedPropertyName
                && is_forwarded_arg(prop_assign.initializer())
        }
        Kind::ShorthandPropertyAssignment => true,
        _ => false,
    }
}

fn is_forwarded_object_literal(node: &ObjectLiteralExpression) -> bool {
    node.properties()
        .nodes()
        .iter()
        .all(|&prop| is_forwarded_object_property(prop))
}

fn is_forwarded_array_literal(node: &ArrayLiteralExpression) -> bool {
    node.elements()
        .nodes()
        .iter()
        .all(|&elem| is_forwarded_arg(elem))
}

fn is_forwarded_arg(node: P<Node>) -> bool {
    match node.kind() {
        Kind::Identifier | Kind::PropertyAccessExpression => is_simple_callee(node),
        Kind::StringLiteral
        | Kind::NumericLiteral
        | Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::NullKeyword
        | Kind::NoSubstitutionTemplateLiteral => true,
        Kind::TemplateExpression => is_forwarded_template(node.as_template_expression()),
        Kind::ObjectLiteralExpression => {
            is_forwarded_object_literal(node.as_object_literal_expression())
        }
        Kind::ArrayLiteralExpression => {
            is_forwarded_array_literal(node.as_array_literal_expression())
        }
        Kind::SpreadElement => is_forwarded_arg(node.as_spread_element().expression()),
        Kind::CallExpression => is_composed_call(node),
        _ => false,
    }
}

fn is_eligible_delegated_wrapper(fn_node: P<Node>, name_ident: P<Node>) -> bool {
    let Some(func_base) = fn_node.function_like_data() else {
        return false;
    };
    if !ast::is_identifier(name_ident)
        || tsrs_kernel::is_generator_function(fn_node)
        || func_base.type_parameters().is_some()
    {
        return false;
    }
    if fn_node
        .modifier_nodes()
        .iter()
        .any(|&mod_node| mod_node.kind() == Kind::AsyncKeyword)
    {
        return false;
    }
    if func_base
        .type_()
        .is_some_and(|ret_type| ret_type.kind() == Kind::TypePredicate)
    {
        return false;
    }
    if fn_node.parameters().iter().any(|&param| {
        !param.name().is_some_and(ast::is_identifier)
            || param.as_parameter_declaration().initializer().is_some()
    }) {
        return false;
    }
    fn_node.body().is_some()
}

fn single_delegated_body_call(body: P<Node>) -> Option<P<Node>> {
    if !ast::is_block(body) {
        return Some(body);
    }
    let stmts = body.as_block().statements().nodes();
    if stmts.len() != 1 {
        return None;
    }
    let stmt = stmts[0];
    if ast::is_return_statement(stmt) {
        return stmt.as_return_statement().expression();
    }
    if ast::is_expression_statement(stmt) {
        return Some(stmt.as_expression_statement().expression());
    }
    None
}

#[must_use]
pub fn find_delegated_call(
    fn_node: P<Node>,
    name_ident: P<Node>,
    decl: P<Node>,
) -> Option<DelegatedCallCandidate> {
    if !is_eligible_delegated_wrapper(fn_node, name_ident) {
        return None;
    }
    let body = fn_node.body()?;
    let call = single_delegated_body_call(body)?;
    if !is_composed_call(call) {
        return None;
    }
    let callee = call.as_call_expression().expression();
    if ast::is_identifier(callee)
        && callee.as_identifier().text() == name_ident.as_identifier().text()
    {
        return None;
    }
    Some(DelegatedCallCandidate {
        declaration: decl,
        function_node: fn_node,
        name_node: name_ident,
        call_node: call,
        callee_node: callee,
    })
}
