use super::bindings::Callback;
use super::syntax::{argument, call, identifier, static_member, unwrap};
use rustc_hash::FxHashSet;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AssertionStyle {
    Expect,
    Assert,
}

pub(super) struct Assertion {
    pub call: P<Node>,
    pub style: AssertionStyle,
    pub method: String,
    pub subject: Option<P<Node>>,
    pub expected: Vec<P<Node>>,
    pub modifiers: FxHashSet<String>,
    pub expect_call: Option<P<Node>>,
}

impl Assertion {
    pub(super) fn parse(node: P<Node>) -> Option<Self> {
        Self::expect(node).or_else(|| Self::assert(node))
    }

    fn expect(node: P<Node>) -> Option<Self> {
        let call_expr = node.as_call_expression();
        let (receiver, method) = static_member(call_expr.expression())?;
        let mut current = unwrap(receiver);
        let mut modifiers = FxHashSet::default();
        while let Some((object, modifier)) = static_member(current) {
            modifiers.insert(modifier);
            current = unwrap(object);
        }
        let expect_call = call(current)?;
        let expect_callee = expect_call.as_call_expression().expression();
        let expect_owner = static_member(expect_callee).map_or(expect_callee, |(object, _)| object);
        if identifier(expect_owner)?.as_identifier().text() != "expect" {
            return None;
        }
        Some(Self {
            call: node,
            style: AssertionStyle::Expect,
            method,
            subject: argument(expect_call, 0).map(unwrap),
            expected: call_expr
                .arguments()
                .nodes()
                .iter()
                .copied()
                .filter(|arg| arg.kind() != Kind::SpreadElement)
                .collect(),
            modifiers,
            expect_call: Some(expect_call),
        })
    }

    fn assert(node: P<Node>) -> Option<Self> {
        let call_expr = node.as_call_expression();
        let callee = call_expr.expression();
        let (owner, method) =
            static_member(callee).unwrap_or_else(|| (callee, "assert".to_owned()));
        if identifier(owner)?.as_identifier().text() != "assert" {
            return None;
        }
        Some(Self {
            call: node,
            style: AssertionStyle::Assert,
            method,
            subject: argument(node, 0).map(unwrap),
            expected: call_expr
                .arguments()
                .nodes()
                .iter()
                .copied()
                .skip(1)
                .filter(|arg| arg.kind() != Kind::SpreadElement)
                .collect(),
            modifiers: FxHashSet::default(),
            expect_call: None,
        })
    }

    pub(super) fn equality(&self) -> Option<(P<Node>, P<Node>)> {
        let equality = match self.style {
            AssertionStyle::Expect => {
                matches!(
                    self.method.as_str(),
                    "toBe" | "toEqual" | "toStrictEqual" | "toMatchObject"
                ) && !self.modifiers.contains("not")
                    && !self.modifiers.contains("rejects")
            }
            AssertionStyle::Assert => equality_method(&self.method),
        };
        equality.then_some(())?;
        Some((self.subject?, *self.expected.first()?))
    }
}

pub(super) fn equality_method(name: &str) -> bool {
    matches!(
        name,
        "deepEqual" | "deepStrictEqual" | "equal" | "strictEqual"
    )
}

pub(super) fn test_callee(expression: P<Node>, specify: bool) -> bool {
    if let Some(ident) = identifier(expression) {
        let name = ident.as_identifier().text();
        return matches!(name, "fit" | "it" | "test" | "xit" | "xtest")
            || (specify && name == "specify");
    }
    if let Some((object, _)) = static_member(expression) {
        return test_callee(object, specify);
    }
    call(expression)
        .is_some_and(|call_node| test_callee(call_node.as_call_expression().expression(), specify))
}

pub(super) fn test_callback(call_node: P<Node>) -> Option<Callback> {
    let call_expr = call_node.as_call_expression();
    if !test_callee(call_expr.expression(), true) {
        return None;
    }
    call_expr
        .arguments()
        .nodes()
        .iter()
        .copied()
        .filter(|arg| arg.kind() != Kind::SpreadElement)
        .find_map(Callback::from_expression)
}

fn predicate(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    if inner.kind() == Kind::BinaryExpression
        && inner.as_binary_expression().operator_token().kind() == Kind::InKeyword
    {
        return true;
    }
    let Some(call_node) = call(inner) else {
        return false;
    };
    let Some((object, method)) = static_member(call_node.as_call_expression().expression()) else {
        return false;
    };
    match method.as_str() {
        "includes" | "hasOwnProperty" => true,
        "hasOwn" => identifier(object).is_some_and(|id| id.as_identifier().text() == "Object"),
        "some" => argument(call_node, 0)
            .and_then(Callback::from_expression)
            .is_some_and(|callback| {
                callback.expression_body().is_some()
                    || callback.body().is_some_and(|body| {
                        body.as_block().statements().nodes().iter().any(|&stmt| {
                            stmt.kind() == Kind::ReturnStatement
                                && stmt.as_return_statement().expression().is_some()
                        })
                    })
            }),
        _ => false,
    }
}

fn is_boolean_literal(node: P<Node>) -> bool {
    matches!(node.kind(), Kind::TrueKeyword | Kind::FalseKeyword)
}

pub(super) fn is_membership(node: P<Node>) -> bool {
    let call_expr = node.as_call_expression();
    let callee = call_expr.expression();
    let name = identifier(callee)
        .map(|id| id.as_identifier().text().to_owned())
        .or_else(|| static_member(callee).map(|(_, name)| name));
    let subject = argument(node, 0);
    if let (Some(name), Some(subject)) = (name, subject) {
        if equality_method(&name)
            && predicate(subject)
            && argument(node, 1).is_some_and(is_boolean_literal)
        {
            return true;
        }
        let inner_subj = unwrap(subject);
        let negated = inner_subj.kind() == Kind::PrefixUnaryExpression
            && inner_subj.as_prefix_unary_expression().operator() == Kind::ExclamationToken
            && predicate(inner_subj.as_prefix_unary_expression().operand());
        if matches!(name.as_str(), "ok" | "assert") && (predicate(subject) || negated) {
            return true;
        }
    }
    let Some(record) = Assertion::expect(node) else {
        return false;
    };
    match record.method.as_str() {
        "toContain" => true,
        "toHaveProperty" => call_expr.arguments().nodes().len() <= 1,
        "toBe" | "toEqual" | "toStrictEqual" => {
            argument(node, 0).is_some_and(is_boolean_literal)
                && record.subject.is_some_and(predicate)
        }
        _ => false,
    }
}
