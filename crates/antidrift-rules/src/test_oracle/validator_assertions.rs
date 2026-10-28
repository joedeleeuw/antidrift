use super::Finding;
use super::assertions::{Assertion, AssertionStyle};
use super::bindings::{Callback, Oracle};
use super::syntax::{awaited, call, identifier, member, root_identifier, static_member};
use super::validators::{origin, schema_provenance};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

fn function_origin(subject: P<Node>, oracle: &Oracle) -> Option<P<Node>> {
    let callback = Callback::from_expression(subject)?;
    if let Some(expression) = callback.expression_body() {
        return origin(expression, oracle, 0);
    }
    let mut found = None;
    for &statement in callback.body()?.as_block().statements().nodes() {
        let expression = match statement.kind() {
            Kind::ExpressionStatement => Some(statement.as_expression_statement().expression()),
            Kind::ReturnStatement => statement.as_return_statement().expression(),
            Kind::VariableStatement => {
                let mut initialized = false;
                let decls = statement
                    .as_variable_statement()
                    .declaration_list()
                    .as_variable_declaration_list()
                    .declarations()
                    .nodes();
                for initializer in decls
                    .iter()
                    .filter_map(|decl| decl.as_variable_declaration().initializer())
                {
                    let candidate = origin(initializer, oracle, 0)?;
                    found = found.or(Some(candidate));
                    initialized = true;
                }
                if !initialized {
                    return None;
                }
                continue;
            }
            _ => return None,
        };
        let candidate = origin(expression?, oracle, 0)?;
        found = found.or(Some(candidate));
    }
    found
}

fn act_output(expression: P<Node>, oracle: &Oracle, depth: usize) -> bool {
    if depth > 12 {
        return false;
    }
    let expression = awaited(expression);
    if identifier(expression).is_some() {
        return oracle
            .binding_source(expression)
            .is_some_and(|source| act_output(source, oracle, depth + 1));
    }
    if let Some(object) = super::syntax::member_object(expression) {
        return act_output(object, oracle, depth + 1);
    }
    let Some(call_node) = call(expression) else {
        return false;
    };
    let call_expr = call_node.as_call_expression();
    let callee = awaited(call_expr.expression());
    let forwards = static_member(callee).is_some_and(|(object, _)| {
        root_identifier(object).is_some_and(|ident| {
            matches!(ident.as_identifier().text(), "Array" | "JSON" | "Object")
        })
    }) || oracle.local_function(callee).is_some();
    !forwards
        || call_expr
            .arguments()
            .nodes()
            .iter()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement)
            .any(|argument| act_output(argument, oracle, depth + 1))
}

fn reads_acceptance(subject: P<Node>, origin_call: P<Node>) -> bool {
    let mut current = awaited(subject);
    while super::syntax::call(current).is_none_or(|call_node| call_node != origin_call) {
        let Some((object, property)) = member(current) else {
            return false;
        };
        if matches!(property.as_str(), "error" | "issues" | "success") {
            return true;
        }
        current = awaited(object);
    }
    false
}

pub(super) fn finding(call_node: P<Node>, oracle: &Oracle) -> Option<Finding> {
    let record = Assertion::parse(call_node)?;
    if record.style == AssertionStyle::Assert
        && static_member(call_node.as_call_expression().expression()).is_none()
    {
        return None;
    }
    if let Some(expect_call) = record.expect_call
        && identifier(expect_call.as_call_expression().expression()).is_none()
    {
        return None;
    }
    let subject = awaited(record.subject?);
    if matches!(
        record.method.as_str(),
        "doesNotReject" | "doesNotThrow" | "rejects" | "throws" | "toThrow" | "toThrowError"
    ) {
        return function_origin(subject, oracle)
            .or_else(|| origin(subject, oracle, 0))
            .map(|_| Finding::ValidatorThrowOracle);
    }
    let origin_call = origin(subject, oracle, 0)?;
    if record.modifiers.contains("rejects") {
        return Some(Finding::ValidatorThrowOracle);
    }
    let inputs: Vec<_> = origin_call
        .as_call_expression()
        .arguments()
        .nodes()
        .iter()
        .copied()
        .filter(|argument| argument.kind() != Kind::SpreadElement)
        .filter(|&argument| !schema_provenance(argument, oracle, 0))
        .collect();
    let arranged = inputs
        .iter()
        .all(|&argument| !act_output(argument, oracle, 0));
    if !arranged
        && !record.expected.is_empty()
        && !reads_acceptance(subject, origin_call)
        && super::dependencies::independent(&inputs, &record.expected, oracle)
    {
        return None;
    }
    Some(Finding::ValidatorOutputOracle)
}
