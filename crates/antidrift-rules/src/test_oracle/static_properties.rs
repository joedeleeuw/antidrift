use super::assertions::test_callee;
use super::bindings::Oracle;
use super::syntax::{
    argument, call, explicit_test_file, identifier, literal, static_member, unwrap,
};
use antidrift_kernel::local_binding::{Binding, binding_for_declarator};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

fn projection(expression: P<Node>, parameter: &str) -> bool {
    let expression = unwrap(expression);
    if identifier(expression).is_some_and(|ident| ident.as_identifier().text() == parameter) {
        return true;
    }
    if let Some((object, _)) = static_member(expression) {
        return projection(object, parameter);
    }
    if expression.kind() == Kind::ElementAccessExpression {
        return projection(
            expression.as_element_access_expression().expression(),
            parameter,
        );
    }
    if expression.kind() != Kind::ConditionalExpression {
        return false;
    }
    let conditional = expression.as_conditional_expression();
    let guard = call(unwrap(conditional.condition())).is_some_and(|call_node| {
        let call_expr = call_node.as_call_expression();
        call_expr.arguments().nodes().len() == 1
            && static_member(call_expr.expression()).is_some_and(|(object, method)| {
                identifier(object).is_some_and(|ident| ident.as_identifier().text() == "Array")
                    && method == "isArray"
            })
            && argument(call_node, 0)
                .and_then(identifier)
                .is_some_and(|ident| ident.as_identifier().text() == parameter)
    });
    guard
        && projection(conditional.when_true(), parameter)
        && projection(conditional.when_false(), parameter)
}

fn transparent(expression: P<Node>, oracle: &Oracle) -> Option<P<Node>> {
    let call_node = call(expression)?;
    if call_node.as_call_expression().arguments().nodes().len() != 1 {
        return None;
    }
    let function = oracle.local_function(call_node.as_call_expression().expression())?;
    let parameter = function.single_parameter()?;
    projection(function.direct_return(true)?, parameter)
        .then(|| argument(call_node, 0))
        .flatten()
}

fn indexed_root(
    expression: P<Node>,
    loop_symbol: Binding,
    oracle: &Oracle,
    depth: usize,
) -> Option<P<Node>> {
    if depth > 12 {
        return None;
    }
    let expression = unwrap(expression);
    if let Some(arg) = transparent(expression, oracle) {
        return indexed_root(arg, loop_symbol, oracle, depth + 1);
    }
    if expression.kind() != Kind::ElementAccessExpression {
        return None;
    }
    let member = expression.as_element_access_expression();
    if oracle.symbol(identifier(member.argument_expression())?)? != loop_symbol {
        return None;
    }
    let mut root = unwrap(member.expression());
    loop {
        root = match root.kind() {
            Kind::PropertyAccessExpression => {
                unwrap(root.as_property_access_expression().expression())
            }
            Kind::ElementAccessExpression => {
                unwrap(root.as_element_access_expression().expression())
            }
            _ => break,
        };
    }
    identifier(root)?;
    Some(root)
}

fn assertion_subject(call_node: P<Node>) -> Option<P<Node>> {
    let call_expr = call_node.as_call_expression();
    let (object, matcher) = static_member(call_expr.expression())?;
    if !matches!(matcher.as_str(), "toBe" | "toEqual" | "toStrictEqual")
        || call_expr.arguments().nodes().len() != 1
        || !literal(argument(call_node, 0)?)
    {
        return None;
    }
    let expect_call = super::syntax::call(object)?;
    let expect_expr = expect_call.as_call_expression();
    if identifier(expect_expr.expression())?.as_identifier().text() != "expect"
        || expect_expr.arguments().nodes().len() != 1
    {
        return None;
    }
    argument(expect_call, 0)
}

fn inside_test(statement: P<Node>) -> bool {
    let mut nearest = None;
    let mut cursor = statement.parent();
    while let Some(ancestor) = cursor {
        if matches!(
            ancestor.kind(),
            Kind::ArrowFunction | Kind::FunctionExpression
        ) {
            nearest = Some(ancestor);
            break;
        }
        cursor = ancestor.parent();
    }
    let Some(nearest) = nearest else {
        return false;
    };
    let Some(parent) = nearest.parent() else {
        return false;
    };
    if parent.kind() != Kind::CallExpression {
        return false;
    }
    test_callee(parent.as_call_expression().expression(), false)
}

pub(super) fn is_echo(statement: P<Node>, oracle: &Oracle, filename: &str) -> bool {
    if !explicit_test_file(filename) || !inside_test(statement) {
        return false;
    }
    let for_of = statement.as_for_in_or_of_statement();
    let initializer = for_of.initializer();
    if initializer.kind() != Kind::VariableDeclarationList {
        return false;
    }
    let decls = initializer
        .as_variable_declaration_list()
        .declarations()
        .nodes();
    if decls.len() != 1 {
        return false;
    }
    let decl = decls[0];
    let Some(name_node) = decl.name() else {
        return false;
    };
    if !ast::is_identifier(name_node) {
        return false;
    }
    let Some(symbol) = binding_for_declarator(decl) else {
        return false;
    };
    let right = unwrap(for_of.expression());
    if right.kind() != Kind::ArrayLiteralExpression {
        return false;
    }
    let keys = right.as_array_literal_expression().elements().nodes();
    if keys.len() < 2
        || !keys
            .iter()
            .all(|&key| matches!(key.kind(), Kind::StringLiteral | Kind::NumericLiteral))
    {
        return false;
    }
    has_indexed_assertion(for_of.statement(), symbol, oracle)
}

fn has_indexed_assertion(node: P<Node>, symbol: Binding, oracle: &Oracle) -> bool {
    if node.kind() == Kind::CallExpression
        && assertion_subject(node)
            .and_then(|subject| indexed_root(subject, symbol, oracle, 0))
            .is_some_and(|root| oracle.initializer(root, true).is_some())
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if has_indexed_assertion(child, symbol, oracle) {
            found = true;
            return true;
        }
        false
    });
    found
}
