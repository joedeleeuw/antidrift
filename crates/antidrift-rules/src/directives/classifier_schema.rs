use antidrift_kernel::decode_guards::{
    is_kind_tagged_schema_constructor, is_optionality_schema_method,
    is_value_space_schema_constructor,
};
use antidrift_kernel::provenance::{symbol_at_node, symbol_declarations};
use antidrift_kernel::tsrs_kernel::{terminal_member_name, unwrap_expression};
use tsrs_ast::{Kind, Node};
use tsrs_checker::Checker;
use tsrs_core::P;

const MAX_BINDING_HOPS: usize = 4;

pub(super) fn is_classifier_schema(checker: &mut Checker, schema: P<Node>) -> bool {
    classifies(checker, schema, 0)
}

pub(super) fn schema_receiver(decode_call: P<Node>) -> Option<P<Node>> {
    if decode_call.kind() != Kind::CallExpression {
        return None;
    }
    receiver_of(unwrap_expression(
        decode_call.as_call_expression().expression(),
    ))
}

fn receiver_of(callee: P<Node>) -> Option<P<Node>> {
    (callee.kind() == Kind::PropertyAccessExpression)
        .then(|| callee.as_property_access_expression().expression())
}

fn classifies(checker: &mut Checker, schema: P<Node>, hops: usize) -> bool {
    let expr = unwrap_expression(schema);
    match expr.kind() {
        Kind::Identifier => {
            hops < MAX_BINDING_HOPS
                && declared_initializer(checker, expr)
                    .is_some_and(|initializer| classifies(checker, initializer, hops + 1))
        }
        Kind::CallExpression => {
            let call = expr.as_call_expression();
            let callee = unwrap_expression(call.expression());
            let Some(method) = terminal_member_name(callee) else {
                return false;
            };
            if is_value_space_schema_constructor(method)
                || is_kind_tagged_schema_constructor(method)
            {
                return true;
            }
            let first_argument = call.arguments().nodes().first().copied();
            match method {
                "union" => first_argument
                    .is_some_and(|members| every_member_classifies(checker, members, hops)),
                "object" => first_argument.is_some_and(has_required_literal_property),
                _ => {
                    receiver_of(callee).is_some_and(|receiver| classifies(checker, receiver, hops))
                }
            }
        }
        _ => false,
    }
}

fn declared_initializer(checker: &mut Checker, ident: P<Node>) -> Option<P<Node>> {
    let symbol = symbol_at_node(checker, ident);
    symbol_declarations(checker, symbol)
        .into_iter()
        .find(|declaration| declaration.kind() == Kind::VariableDeclaration)
        .and_then(|declaration| declaration.as_variable_declaration().initializer())
}

fn every_member_classifies(checker: &mut Checker, members: P<Node>, hops: usize) -> bool {
    let array = unwrap_expression(members);
    if array.kind() != Kind::ArrayLiteralExpression {
        return false;
    }
    let elements = array.as_array_literal_expression().elements().nodes();
    !elements.is_empty()
        && elements
            .iter()
            .all(|&element| classifies(checker, element, hops))
}

fn has_required_literal_property(shape: P<Node>) -> bool {
    let object = unwrap_expression(shape);
    object.kind() == Kind::ObjectLiteralExpression
        && object
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .any(|&property| {
                property.kind() == Kind::PropertyAssignment
                    && is_required_literal(property.as_property_assignment().initializer())
            })
}

fn is_required_literal(initializer: P<Node>) -> bool {
    let mut cursor = unwrap_expression(initializer);
    while cursor.kind() == Kind::CallExpression {
        let callee = unwrap_expression(cursor.as_call_expression().expression());
        let Some(method) = terminal_member_name(callee) else {
            return false;
        };
        if is_optionality_schema_method(method) {
            return false;
        }
        if method == "literal" {
            return true;
        }
        let Some(receiver) = receiver_of(callee) else {
            return false;
        };
        cursor = unwrap_expression(receiver);
    }
    false
}
