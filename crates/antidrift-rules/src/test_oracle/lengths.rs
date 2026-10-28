use super::Finding;
use super::assertions::{Assertion, AssertionStyle};
use super::bindings::Oracle;
use super::block::BlockFacts;
use super::classification::Classification;
use super::literals;
use super::paths::{act_for_root, length_parts, member_path};
use super::syntax::{identifier, numeric_value, unwrap};
use tsrs_ast::Kind;

pub(super) fn echo(record: &Assertion, facts: &BlockFacts, oracle: &Oracle) -> Option<Finding> {
    let (collection, count) = length_parts(record)?;
    if let Some(reference) = member_path(count)
        && reference
            .path
            .last()
            .is_some_and(|segment| segment == "length")
        && identifier(reference.root)
            .is_some_and(|ident| facts.argument_names.contains(ident.as_identifier().text()))
    {
        return Some(Finding::LengthEcho);
    }
    let count_val = numeric_value(unwrap(count))?;
    let act = act_for_root(collection.root, facts)?;
    act.as_call_expression()
        .arguments()
        .nodes()
        .iter()
        .copied()
        .filter(|argument| argument.kind() != Kind::SpreadElement)
        .any(|argument| {
            matches!(
                literals::at_path(argument, &collection.path, oracle),
                Some(array)
                    if array.kind() == Kind::ArrayLiteralExpression
                        && array
                            .as_array_literal_expression()
                            .elements()
                            .nodes()
                            .iter()
                            .all(|element| {
                                !matches!(
                                    element.kind(),
                                    Kind::SpreadElement | Kind::OmittedExpression
                                )
                            })
                        && array.as_array_literal_expression().elements().nodes().len() as f64
                            == count_val
            )
        })
        .then_some(Finding::LengthEcho)
}

pub(super) fn has_contents_oracle(
    record: &Assertion,
    facts: &BlockFacts,
    classifications: &[Classification],
    oracle: &Oracle,
) -> bool {
    let Some((collection, _)) = length_parts(record) else {
        return false;
    };
    let Some(collection_root) = identifier(collection.root) else {
        return false;
    };
    facts
        .assertions
        .iter()
        .zip(classifications)
        .any(|(sibling, classification)| {
            let deep = match sibling.style {
                AssertionStyle::Expect => {
                    matches!(sibling.method.as_str(), "toEqual" | "toStrictEqual")
                }
                AssertionStyle::Assert => {
                    matches!(sibling.method.as_str(), "deepEqual" | "deepStrictEqual")
                }
            };
            if !classification.independent || sibling.call == record.call || !deep {
                return false;
            }
            let Some((actual, expected)) = sibling.equality() else {
                return false;
            };
            if !literals::resolve(expected, oracle, 8)
                .is_some_and(|node| node.kind() == Kind::ArrayLiteralExpression)
            {
                return false;
            }
            member_path(actual).is_some_and(|reference| {
                reference.path == collection.path
                    && identifier(reference.root).is_some_and(|ident| {
                        ident.as_identifier().text() == collection_root.as_identifier().text()
                    })
            })
        })
}
