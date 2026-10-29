use super::assertions::{Assertion, AssertionStyle};
use super::bindings::{Callback, Oracle};
use super::block::BlockFacts;
use super::literals::template_text;
use super::syntax::{
    argument, awaited, call, identifier, numeric_value, object_property, static_member,
};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

#[derive(Clone, PartialEq)]
pub(super) enum Shape {
    String(String),
    Number(u64),
    Boolean(bool),
    Null,
    BigInt(String),
    Array(Vec<Shape>),
    Object(Vec<(String, Shape)>),
}

pub(super) fn resolve(
    expression: P<Node>,
    callback: Callback,
    oracle: &Oracle,
    depth: usize,
) -> Option<(Shape, bool)> {
    if depth > 8 {
        return None;
    }
    let expression = awaited(expression);
    let shape = match expression.kind() {
        Kind::StringLiteral => Shape::String(expression.as_string_literal().text().to_owned()),
        Kind::NumericLiteral => Shape::Number(numeric_value(expression)?.to_bits()),
        Kind::TrueKeyword => Shape::Boolean(true),
        Kind::FalseKeyword => Shape::Boolean(false),
        Kind::NullKeyword => Shape::Null,
        Kind::BigIntLiteral => Shape::BigInt(expression.text().trim_end_matches('n').to_owned()),
        Kind::NoSubstitutionTemplateLiteral => Shape::String(template_text(expression)?),
        Kind::ArrayLiteralExpression => Shape::Array(
            expression
                .as_array_literal_expression()
                .elements()
                .nodes()
                .iter()
                .map(|&element| {
                    if matches!(
                        element.kind(),
                        Kind::SpreadElement | Kind::OmittedExpression
                    ) {
                        return None;
                    }
                    resolve(element, callback, oracle, depth + 1).map(|(shape, _)| shape)
                })
                .collect::<Option<Vec<_>>>()?,
        ),
        Kind::ObjectLiteralExpression => {
            let mut properties = expression
                .as_object_literal_expression()
                .properties()
                .nodes()
                .iter()
                .map(|&property| {
                    let (name, value, _) = object_property(property)?;
                    Some((name, resolve(value, callback, oracle, depth + 1)?.0))
                })
                .collect::<Option<Vec<_>>>()?;
            properties.sort_by(|(left, _), (right, _)| left.cmp(right));
            Shape::Object(properties)
        }
        Kind::Identifier => {
            return resolve(
                oracle.local_initializer(expression, callback)?,
                callback,
                oracle,
                depth + 1,
            );
        }
        _ => return shape_factory(expression, callback, oracle, depth),
    };
    Some((shape, false))
}

fn shape_factory(
    expression: P<Node>,
    callback: Callback,
    oracle: &Oracle,
    depth: usize,
) -> Option<(Shape, bool)> {
    let call_node = call(expression)?;
    let (object, method) = static_member(call_node.as_call_expression().expression())?;
    if !matches!(method.as_str(), "arrayContaining" | "objectContaining")
        || identifier(object)?.as_identifier().text() != "expect"
    {
        return None;
    }
    let (shape, _) = resolve(argument(call_node, 0)?, callback, oracle, depth + 1)?;
    Some((shape, true))
}

pub(super) fn mock_shape(call_node: P<Node>, callback: Callback, oracle: &Oracle) -> Option<Shape> {
    let (_, method) = static_member(call_node.as_call_expression().expression())?;
    if !matches!(
        method.as_str(),
        "mockImplementation"
            | "mockImplementationOnce"
            | "mockResolvedValue"
            | "mockResolvedValueOnce"
            | "mockReturnValue"
            | "mockReturnValueOnce"
    ) {
        return None;
    }
    let argument = argument(call_node, 0)?;
    let arranged = if method.starts_with("mockImplementation") {
        Callback::from_expression(argument)?.direct_return(false)?
    } else {
        argument
    };
    resolve(arranged, callback, oracle, 0).map(|(shape, _)| shape)
}

fn subset(expected: &Shape, arranged: &Shape) -> bool {
    match (expected, arranged) {
        (Shape::Array(expected), Shape::Array(arranged)) => {
            expected.len() <= arranged.len()
                && expected
                    .iter()
                    .zip(arranged)
                    .all(|(expected, arranged)| subset(expected, arranged))
        }
        (Shape::Object(expected), Shape::Object(arranged)) => {
            expected.iter().all(|(name, expected)| {
                arranged
                    .iter()
                    .rev()
                    .find(|(key, _)| key == name)
                    .is_some_and(|(_, arranged)| subset(expected, arranged))
            })
        }
        _ => expected == arranged,
    }
}

fn contains_shape(arranged: &Shape, expected: &Shape, partial: bool) -> bool {
    if (partial && subset(expected, arranged)) || (!partial && expected == arranged) {
        return true;
    }
    match arranged {
        Shape::Array(elements) => elements
            .iter()
            .any(|element| contains_shape(element, expected, partial)),
        Shape::Object(properties) => properties
            .iter()
            .any(|(_, property)| contains_shape(property, expected, partial)),
        _ => false,
    }
}

fn response_json(expression: P<Node>, callback: Callback, oracle: &Oracle, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let expression = awaited(expression);
    if call(expression).is_some_and(|call_node| {
        static_member(call_node.as_call_expression().expression())
            .is_some_and(|(_, method)| method == "json")
    }) {
        return true;
    }
    if identifier(expression).is_some() {
        return oracle
            .local_initializer(expression, callback)
            .is_some_and(|initializer| response_json(initializer, callback, oracle, depth + 1));
    }
    super::syntax::member_object(expression)
        .is_some_and(|object| response_json(object, callback, oracle, depth + 1))
}

pub(super) fn matches_mock(record: &Assertion, facts: &BlockFacts, oracle: &Oracle) -> bool {
    if record.style != AssertionStyle::Expect
        || !matches!(
            record.method.as_str(),
            "toEqual" | "toMatchObject" | "toStrictEqual"
        )
        || facts.mocked_shapes.is_empty()
        || oracle.owner(record.call) != Some(facts.callback.id())
    {
        return false;
    }
    let Some((expected, partial)) = record
        .expected
        .first()
        .and_then(|&expected| resolve(expected, facts.callback, oracle, 0))
    else {
        return false;
    };
    let partial = partial || record.method == "toMatchObject";
    facts
        .mocked_shapes
        .iter()
        .any(|arranged| contains_shape(arranged, &expected, partial))
        && record
            .subject
            .is_some_and(|subject| response_json(subject, facts.callback, oracle, 0))
}
