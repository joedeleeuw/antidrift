use super::Finding;
use super::assertions::{Assertion, AssertionStyle, is_membership};
use super::bindings::{Callback, Oracle};
use super::block::BlockFacts;
use super::literals;
use super::paths::{PathReference, act_for_root, arranged_path, member_path, outcome};
use super::syntax::{
    call_expression_of, identifier_of, literal_container, static_member, unwrap_expression,
};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub(super) struct Classification {
    pub independent: bool,
    pub finding: Option<Finding>,
}

pub(super) fn classify(record: &Assertion, facts: &BlockFacts, oracle: &Oracle) -> Classification {
    if error_shape(record, facts, oracle) {
        return classified(Some(Finding::ErrorShapeEcho));
    }
    if is_membership(record.call) {
        return Classification {
            independent: false,
            finding: None,
        };
    }
    let finding = if super::response_shapes::matches_mock(record, facts, oracle) {
        Some(Finding::MockedResponseBodyOracle)
    } else {
        mock_echo(record, facts)
            .or_else(|| super::lengths::echo(record, facts, oracle))
            .or_else(|| outcome_echo(record, facts))
            .or_else(|| input_echo(record, facts, oracle))
            .or_else(|| existence_echo(record, oracle))
    };
    classified(finding)
}

fn classified(finding: Option<Finding>) -> Classification {
    Classification {
        independent: finding.is_none(),
        finding,
    }
}

fn arranged_parse(expression: P<Node>) -> bool {
    call_expression_of(expression).is_some_and(|call_node| {
        let call_expr = call_node.as_call_expression();
        !call_expr.arguments().nodes().is_empty()
            && static_member(call_expr.expression())
                .is_some_and(|(_, method)| matches!(method.as_str(), "parse" | "parseAsync"))
    })
}

fn throwing_parse(record: &Assertion, oracle: &Oracle) -> bool {
    let Some(subject) = record.subject else {
        return false;
    };
    if let Some(callback) = Callback::from_expression(subject) {
        if callback.expression_body().is_some_and(arranged_parse) {
            return true;
        }
        return contains_parse_in_callback(callback.id(), callback, oracle);
    }
    record.modifiers.contains("rejects") && arranged_parse(subject)
}

fn contains_parse_in_callback(node: P<Node>, callback: Callback, oracle: &Oracle) -> bool {
    if node != callback.id()
        && oracle.in_block(node, callback)
        && node.kind() == Kind::CallExpression
        && arranged_parse(node)
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if contains_parse_in_callback(child, callback, oracle) {
            found = true;
            return true;
        }
        false
    });
    found
}

pub(super) fn error_shape(record: &Assertion, facts: &BlockFacts, oracle: &Oracle) -> bool {
    if record.style == AssertionStyle::Expect
        && record.method == "toThrow"
        && throwing_parse(record, oracle)
    {
        return true;
    }
    let actual = match record.style {
        AssertionStyle::Expect => record.subject,
        AssertionStyle::Assert => record.equality().map(|(actual, _)| actual),
    };
    let Some(path) = actual.and_then(|actual| arranged_path(actual, facts, 8)) else {
        return false;
    };
    path.path.iter().any(|segment| segment == "error")
        && path
            .act
            .as_call_expression()
            .arguments()
            .nodes()
            .iter()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement)
            .any(|argument| identifier_of(argument).is_some() || literal_container(argument))
}

fn outcome_echo(record: &Assertion, facts: &BlockFacts) -> Option<Finding> {
    if record.style == AssertionStyle::Assert && matches!(record.method.as_str(), "ok" | "assert") {
        let inner = unwrap_expression(record.subject?);
        let target = if inner.kind() == Kind::PrefixUnaryExpression
            && inner.as_prefix_unary_expression().operator() == Kind::ExclamationToken
        {
            unwrap_expression(inner.as_prefix_unary_expression().operand())
        } else {
            inner
        };
        return outcome(target, facts).then_some(Finding::OutcomeEcho);
    }
    let (actual, expected) = record.equality()?;
    (matches!(
        unwrap_expression(expected).kind(),
        Kind::TrueKeyword | Kind::FalseKeyword
    ) && outcome(actual, facts))
    .then_some(Finding::OutcomeEcho)
}

fn input_echo(record: &Assertion, facts: &BlockFacts, oracle: &Oracle) -> Option<Finding> {
    let (actual, expected) = record.equality()?;
    let reference = member_path(actual)?;
    let act = act_for_root(reference.root, facts)?;
    echoes_argument(&reference, unwrap_expression(expected), act, oracle)
        .then_some(Finding::InputEcho)
}

fn echoes_argument(
    reference: &PathReference,
    expected: P<Node>,
    act: P<Node>,
    oracle: &Oracle,
) -> bool {
    let act_args = act.as_call_expression().arguments().nodes();
    let argument_names: Vec<_> = act_args
        .iter()
        .copied()
        .filter(|arg| arg.kind() != Kind::SpreadElement)
        .filter_map(identifier_of)
        .map(|ident| ident.as_identifier().text())
        .collect();
    if reference.path.is_empty()
        && identifier_of(expected)
            .is_some_and(|ident| argument_names.contains(&ident.as_identifier().text()))
    {
        return true;
    }
    if let Some(expected_path) = member_path(expected)
        && !expected_path.path.is_empty()
        && expected_path.path == reference.path
        && identifier_of(expected_path.root)
            .is_some_and(|ident| argument_names.contains(&ident.as_identifier().text()))
    {
        return true;
    }
    let spread_echo = if expected.kind() == Kind::ObjectLiteralExpression
        && reference.path.is_empty()
    {
        let props = expected.as_object_literal_expression().properties().nodes();
        !props.is_empty()
            && props.iter().all(|&prop| {
                prop.kind() == Kind::SpreadAssignment
                    && identifier_of(prop.as_spread_assignment().expression())
                        .is_some_and(|ident| argument_names.contains(&ident.as_identifier().text()))
            })
    } else {
        false
    };
    spread_echo
        || act_args
            .iter()
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement)
            .any(|argument| {
                literals::at_path(argument, &reference.path, oracle)
                    .is_some_and(|target| literals::equal(target, expected, 8))
            })
}

fn existence_echo(record: &Assertion, oracle: &Oracle) -> Option<Finding> {
    let truthy = match record.style {
        AssertionStyle::Expect
            if record.modifiers.is_empty()
                && matches!(record.method.as_str(), "toBeDefined" | "toBeTruthy") =>
        {
            record.method == "toBeTruthy"
        }
        AssertionStyle::Assert
            if matches!(record.method.as_str(), "ok" | "assert")
                && record.call.as_call_expression().arguments().nodes().len() == 1 =>
        {
            true
        }
        _ => return None,
    };
    literals::vacuous(literals::resolve(record.subject?, oracle, 8)?, truthy)
        .then_some(Finding::ExistenceEcho)
}

fn mock_echo(record: &Assertion, facts: &BlockFacts) -> Option<Finding> {
    if record.style != AssertionStyle::Expect
        || record.modifiers.contains("not")
        || !matches!(
            record.method.as_str(),
            "toHaveBeenCalledWith"
                | "toHaveBeenLastCalledWith"
                | "toHaveBeenNthCalledWith"
                | "toBeCalledWith"
                | "lastCalledWith"
                | "nthCalledWith"
        )
    {
        return None;
    }
    let skip = usize::from(matches!(
        record.method.as_str(),
        "toHaveBeenNthCalledWith" | "nthCalledWith"
    ));
    record
        .expected
        .iter()
        .copied()
        .skip(skip)
        .any(|argument| {
            if let Some(ident) = identifier_of(argument) {
                return facts.argument_names.contains(ident.as_identifier().text());
            }
            facts
                .argument_literals
                .iter()
                .copied()
                .any(|literal| literals::equal(literal, argument, 8))
        })
        .then_some(Finding::MockCallEcho)
}
