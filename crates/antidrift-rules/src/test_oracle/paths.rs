use super::assertions::{Assertion, AssertionStyle};
use super::block::BlockFacts;
use super::syntax::{awaited, call, identifier, member, static_member, unwrap};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub(super) struct PathReference {
    pub root: P<Node>,
    pub path: Vec<String>,
}

pub(super) struct ActPath {
    pub act: P<Node>,
    pub path: Vec<String>,
}

pub(super) fn member_path(expression: P<Node>) -> Option<PathReference> {
    let mut path = Vec::new();
    let mut current = unwrap(expression);
    while let Some((object, segment)) = member(current) {
        path.push(segment);
        current = unwrap(object);
    }
    if matches!(
        current.kind(),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression
    ) {
        return None;
    }
    path.reverse();
    Some(PathReference {
        root: current,
        path,
    })
}

pub(super) fn act_for_root(root: P<Node>, facts: &BlockFacts) -> Option<P<Node>> {
    if let Some(call_node) = call(root) {
        return Some(call_node);
    }
    call(awaited(
        *facts
            .bindings
            .get(identifier(root)?.as_identifier().text())?,
    ))
}

pub(super) fn arranged_act(root: P<Node>, facts: &BlockFacts) -> Option<P<Node>> {
    let act = act_for_root(root, facts)?;
    (!act.as_call_expression().arguments().nodes().is_empty()).then_some(act)
}

pub(super) fn arranged_path(
    expression: P<Node>,
    facts: &BlockFacts,
    depth: usize,
) -> Option<ActPath> {
    if depth == 0 {
        return None;
    }
    let expression = unwrap(expression);
    if let Some(ident) = identifier(expression) {
        if let Some(act) = arranged_act(expression, facts) {
            return Some(ActPath {
                act,
                path: Vec::new(),
            });
        }
        return arranged_path(
            *facts.bindings.get(ident.as_identifier().text())?,
            facts,
            depth - 1,
        );
    }
    if member(expression).is_some() {
        let reference = member_path(expression)?;
        let mut base = arranged_path(reference.root, facts, depth - 1)?;
        base.path.extend(reference.path);
        return Some(base);
    }
    if let Some(call_node) = call(expression)
        && let Some((object, method)) = static_member(call_node.as_call_expression().expression())
        && let Some(mut base) = arranged_path(object, facts, depth - 1)
    {
        base.path.push(method);
        return Some(base);
    }
    arranged_act(expression, facts).map(|act| ActPath {
        act,
        path: Vec::new(),
    })
}

pub(super) fn outcome(expression: P<Node>, facts: &BlockFacts) -> bool {
    if let Some(reference) = member_path(expression)
        && reference
            .path
            .last()
            .is_some_and(|property| matches!(property.as_str(), "success" | "ok"))
    {
        return arranged_act(reference.root, facts).is_some();
    }
    let Some(call_node) = call(expression) else {
        return false;
    };
    let call_expr = call_node.as_call_expression();
    let Some((object, method)) = static_member(call_expr.expression()) else {
        return false;
    };
    matches!(
        method.as_str(),
        "isOk" | "isErr" | "isSuccess" | "isFailure"
    ) && call_expr.arguments().nodes().is_empty()
        && member_path(object)
            .is_some_and(|reference| arranged_act(reference.root, facts).is_some())
}

pub(super) fn length_parts(record: &Assertion) -> Option<(PathReference, P<Node>)> {
    if record.style == AssertionStyle::Expect && record.method == "toHaveLength" {
        if record.modifiers.contains("not") || record.modifiers.contains("rejects") {
            return None;
        }
        return Some((member_path(record.subject?)?, *record.expected.first()?));
    }
    let (actual, expected) = record.equality()?;
    let mut reference = member_path(actual)?;
    if reference.path.pop()?.as_str() != "length" {
        return None;
    }
    Some((reference, expected))
}
