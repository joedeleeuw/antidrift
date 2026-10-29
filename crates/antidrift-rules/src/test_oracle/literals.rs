use super::bindings::Oracle;
use super::syntax::{literal_container, numeric_literal_value, object_property, unwrap_expression};
use rustc_hash::FxHashMap;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub(super) fn resolve(expression: P<Node>, oracle: &Oracle, depth: usize) -> Option<P<Node>> {
    if depth == 0 {
        return None;
    }
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        return resolve(oracle.initializer(expression, true)?, oracle, depth - 1);
    }
    literal_container(expression).then_some(expression)
}

pub(super) fn template_text(expression: P<Node>) -> Option<String> {
    if expression.kind() == Kind::NoSubstitutionTemplateLiteral {
        return Some(expression.text().to_owned());
    }
    None
}

fn find_object_property(
    object: P<Node>,
    segment: &str,
    oracle: &Oracle,
    depth: usize,
) -> Option<P<Node>> {
    if depth == 0 {
        return None;
    }
    let mut matched = None;
    for &property in object.as_object_literal_expression().properties().nodes() {
        if property.kind() == Kind::SpreadAssignment {
            let arg = property.as_spread_assignment().expression();
            if let Some(spread_obj) = resolve(arg, oracle, depth - 1)
                .filter(|node| node.kind() == Kind::ObjectLiteralExpression)
                && let Some(inherited) =
                    find_object_property(spread_obj, segment, oracle, depth - 1)
            {
                matched = Some(inherited);
            }
        } else if let Some((name, value, _)) = object_property(property)
            && name == segment
        {
            matched = Some(value);
        }
    }
    matched
}

pub(super) fn at_path(base: P<Node>, path: &[String], oracle: &Oracle) -> Option<P<Node>> {
    let mut depth = 8_usize;
    let mut current = resolve(base, oracle, depth)?;
    for segment in path {
        depth = depth.checked_sub(1)?;
        let next = match current.kind() {
            Kind::ObjectLiteralExpression => find_object_property(current, segment, oracle, depth)?,
            Kind::ArrayLiteralExpression => {
                let elements = current.as_array_literal_expression().elements().nodes();
                if elements.iter().any(|element| {
                    matches!(
                        element.kind(),
                        Kind::SpreadElement | Kind::OmittedExpression
                    )
                }) {
                    return None;
                }
                let Ok(index) = segment.parse::<usize>() else {
                    return None;
                };
                *elements.get(index)?
            }
            _ => return None,
        };
        current = resolve(next, oracle, depth).unwrap_or_else(|| unwrap_expression(next));
    }
    Some(current)
}

pub(super) fn equal(left: P<Node>, right: P<Node>, depth: usize) -> bool {
    if depth == 0 {
        return false;
    }
    let left = unwrap_expression(left);
    let right = unwrap_expression(right);
    match (left.kind(), right.kind()) {
        (Kind::StringLiteral, Kind::StringLiteral) => {
            left.as_string_literal().text() == right.as_string_literal().text()
        }
        (Kind::NumericLiteral, Kind::NumericLiteral) => numeric_literal_value(left)
            .zip(numeric_literal_value(right))
            .is_some_and(|(l, r)| l == r),
        (Kind::TrueKeyword, Kind::TrueKeyword)
        | (Kind::FalseKeyword, Kind::FalseKeyword)
        | (Kind::NullKeyword, Kind::NullKeyword) => true,
        (Kind::BigIntLiteral, Kind::BigIntLiteral) => left.text() == right.text(),
        (Kind::Identifier, Kind::Identifier) => {
            left.as_identifier().text() == right.as_identifier().text()
        }
        (Kind::NoSubstitutionTemplateLiteral, Kind::NoSubstitutionTemplateLiteral) => {
            template_text(left).is_some_and(|text| Some(text) == template_text(right))
        }
        (Kind::PrefixUnaryExpression, Kind::PrefixUnaryExpression) => {
            let l_unary = left.as_prefix_unary_expression();
            let r_unary = right.as_prefix_unary_expression();
            l_unary.operator() == Kind::MinusToken
                && r_unary.operator() == Kind::MinusToken
                && equal(l_unary.operand(), r_unary.operand(), depth - 1)
        }
        (Kind::ArrayLiteralExpression, Kind::ArrayLiteralExpression) => {
            let l_elems = left.as_array_literal_expression().elements().nodes();
            let r_elems = right.as_array_literal_expression().elements().nodes();
            l_elems.len() == r_elems.len()
                && l_elems.iter().zip(r_elems).all(|(&l, &r)| {
                    !matches!(l.kind(), Kind::SpreadElement | Kind::OmittedExpression)
                        && !matches!(r.kind(), Kind::SpreadElement | Kind::OmittedExpression)
                        && equal(l, r, depth - 1)
                })
        }
        (Kind::ObjectLiteralExpression, Kind::ObjectLiteralExpression) => {
            objects_equal(left, right, depth - 1)
        }
        _ => false,
    }
}

fn objects_equal(left: P<Node>, right: P<Node>, depth: usize) -> bool {
    let l_props = left.as_object_literal_expression().properties().nodes();
    let r_props = right.as_object_literal_expression().properties().nodes();
    if l_props.len() != r_props.len() {
        return false;
    }
    let mut right_properties = FxHashMap::default();
    for &property in r_props {
        let Some((name, val, _)) = object_property(property) else {
            return false;
        };
        right_properties.insert(name, val);
    }
    l_props.iter().all(|&property| {
        object_property(property).is_some_and(|(name, l_val, _)| {
            right_properties
                .get(&name)
                .is_some_and(|&r_val| equal(l_val, r_val, depth))
        })
    })
}

pub(super) fn vacuous(expression: P<Node>, truthy: bool) -> bool {
    match expression.kind() {
        Kind::ObjectLiteralExpression
        | Kind::ArrayLiteralExpression
        | Kind::RegularExpressionLiteral
        | Kind::TrueKeyword => true,
        Kind::StringLiteral => !truthy || !expression.as_string_literal().text().is_empty(),
        Kind::NumericLiteral => {
            !truthy || numeric_literal_value(expression).is_some_and(|val| val != 0.0)
        }
        Kind::FalseKeyword | Kind::NullKeyword => !truthy,
        Kind::BigIntLiteral => !truthy || !matches!(expression.text(), "0" | "0n"),
        Kind::NoSubstitutionTemplateLiteral => {
            !truthy || template_text(expression).is_some_and(|text| !text.is_empty())
        }
        _ => false,
    }
}
