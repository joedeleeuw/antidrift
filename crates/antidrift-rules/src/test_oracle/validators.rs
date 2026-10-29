use super::bindings::Oracle;
use super::syntax::{
    argument, call_expression_of, identifier_of, root_identifier, static_member,
    unwrap_awaited_expression,
};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub(super) fn schema_source(source: &str) -> bool {
    [
        "@effect/schema",
        "@sinclair/typebox",
        "arktype",
        "effect/Schema",
        "superstruct",
        "valibot",
        "yup",
        "zod",
    ]
    .iter()
    .any(|package| {
        source == *package
            || source
                .strip_prefix(package)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

pub(super) fn schema_provenance(expression: P<Node>, oracle: &Oracle, depth: usize) -> bool {
    if depth > 12 {
        return false;
    }
    let expression = unwrap_awaited_expression(expression);
    if identifier_of(expression).is_some() {
        if oracle
            .import(expression)
            .is_some_and(|(source, _)| schema_source(source))
        {
            return true;
        }
        return oracle
            .initializer(expression, true)
            .is_some_and(|initializer| schema_provenance(initializer, oracle, depth + 1));
    }
    if let Some(object) = super::syntax::member_object(expression) {
        return schema_provenance(object, oracle, depth + 1);
    }
    let callee = match expression.kind() {
        Kind::NewExpression => Some(expression.as_new_expression().expression()),
        _ => call_expression_of(expression)
            .map(|call_node| call_node.as_call_expression().expression()),
    };
    callee.is_some_and(|callee| {
        schema_provenance(
            static_member(callee).map_or(callee, |(object, _)| object),
            oracle,
            depth + 1,
        )
    })
}

fn distinctive(method: &str) -> bool {
    matches!(
        method,
        "decodeUnknown" | "decodeUnknownPromise" | "decodeUnknownSync" | "decodeSync"
    )
}

fn schema_method(method: &str) -> bool {
    matches!(
        method,
        "assert"
            | "decode"
            | "decodeAsync"
            | "parse"
            | "parseAsync"
            | "safeParse"
            | "safeParseAsync"
            | "validate"
    )
}

fn validator_member(expression: P<Node>, oracle: &Oracle) -> bool {
    static_member(expression).is_some_and(|(object, method)| {
        distinctive(&method) || (schema_method(&method) && schema_provenance(object, oracle, 0))
    })
}

fn validator_function(expression: P<Node>, oracle: &Oracle, depth: usize) -> bool {
    if depth > 12 || identifier_of(expression).is_none() {
        return false;
    }
    if let Some((source, imported)) = oracle.import(expression) {
        return schema_source(source)
            && imported.is_some_and(|method| distinctive(method) || schema_method(method));
    }
    let Some(initializer) = oracle
        .initializer(expression, true)
        .map(unwrap_awaited_expression)
    else {
        return false;
    };
    if identifier_of(initializer).is_some() {
        return validator_function(initializer, oracle, depth + 1);
    }
    if static_member(initializer).is_some() {
        return validator_member(initializer, oracle);
    }
    call_expression_of(initializer)
        .and_then(|call_node| static_member(call_node.as_call_expression().expression()))
        .is_some_and(|(object, method)| {
            method == "bind" && validator_member(unwrap_awaited_expression(object), oracle)
        })
}

fn invocation(expression: P<Node>, oracle: &Oracle, depth: usize) -> bool {
    if depth > 12 {
        return false;
    }
    let Some(call_node) = call_expression_of(expression) else {
        return false;
    };
    let callee = unwrap_awaited_expression(call_node.as_call_expression().expression());
    if static_member(callee).is_some() {
        return validator_member(callee, oracle);
    }
    if identifier_of(callee).is_some() {
        return validator_function(callee, oracle, 0);
    }
    invocation(callee, oracle, depth + 1)
}

fn projection(call_node: P<Node>) -> Option<P<Node>> {
    let callee = unwrap_awaited_expression(call_node.as_call_expression().expression());
    if let Some(ident) = identifier_of(callee) {
        return matches!(
            ident.as_identifier().text(),
            "Boolean" | "Number" | "String"
        )
        .then(|| argument(call_node, 0))
        .flatten();
    }
    let (object, method) = static_member(callee)?;
    let root = root_identifier(object).map(|ident| ident.as_identifier().text());
    if matches!(
        (root, method.as_str()),
        (Some("Array"), "from")
            | (Some("Object"), "entries" | "keys" | "values")
            | (Some("JSON"), "stringify")
    ) {
        return argument(call_node, 0);
    }
    matches!(
        method.as_str(),
        "at" | "every"
            | "filter"
            | "find"
            | "findIndex"
            | "flat"
            | "flatMap"
            | "map"
            | "reduce"
            | "reduceRight"
            | "slice"
            | "some"
    )
    .then_some(object)
}

pub(super) fn origin(expression: P<Node>, oracle: &Oracle, depth: usize) -> Option<P<Node>> {
    if depth > 12 {
        return None;
    }
    let expression = unwrap_awaited_expression(expression);
    if invocation(expression, oracle, 0) {
        return call_expression_of(expression);
    }
    if identifier_of(expression).is_some() {
        return origin(oracle.initializer(expression, true)?, oracle, depth + 1);
    }
    if let Some(object) = super::syntax::member_object(expression) {
        return origin(object, oracle, depth + 1);
    }
    if let Some(call_node) = call_expression_of(expression) {
        return origin(projection(call_node)?, oracle, depth + 1);
    }
    if expression.kind() == Kind::NewExpression {
        let constructor = expression.as_new_expression();
        if identifier_of(constructor.expression()).is_some_and(|ident| {
            matches!(
                ident.as_identifier().text(),
                "Map" | "Set" | "WeakMap" | "WeakSet"
            )
        }) {
            let arg = *constructor.arguments()?.nodes().first()?;
            if arg.kind() != Kind::SpreadElement {
                return origin(arg, oracle, depth + 1);
            }
        }
    }
    None
}
