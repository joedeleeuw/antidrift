use super::syntax::{is_function, property_name, unwrap, without_parens};
use antidrift_kernel::directives::split_identifier_words;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-sentinel-absence-fallback";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct AbsenceOptions {
    member_sentinels: bool,
    #[serde(flatten)]
    scope: ScopeOptions,
}

impl Default for AbsenceOptions {
    fn default() -> Self {
        Self {
            member_sentinels: true,
            scope: ScopeOptions::default(),
        }
    }
}

pub struct NoSentinelAbsenceFallback {
    member_sentinels: bool,
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoSentinelAbsenceFallback = NoSentinelAbsenceFallback {
    member_sentinels: true,
    scope: RuleScope::DEFAULT,
};

impl NoSentinelAbsenceFallback {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = decode_rule_options::<AbsenceOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &decoded.scope)?;
        Ok(Self {
            member_sentinels: decoded.member_sentinels,
            scope,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::ReturnStatement),
    Listener::Enter(Kind::ArrowFunction),
];

impl Rule for NoSentinelAbsenceFallback {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            member_sentinels: self.member_sentinels,
        })
    }
}

struct Visitor {
    member_sentinels: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() == Kind::BinaryExpression {
            if !self.member_sentinels {
                return;
            }
            let bin = node.as_binary_expression();
            if bin.operator_token().kind() == Kind::QuestionQuestionToken
                && matches!(
                    unwrap(bin.left()).kind(),
                    Kind::PropertyAccessExpression | Kind::ElementAccessExpression
                )
                && let Some(sentinel) = string_literal(bin.right())
                && ["unknown", "n/a", "none", "unavailable", "error", "missing"]
                    .contains(&sentinel.to_lowercase().as_str())
            {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "sentinelAbsenceFallback",
                        format!(
                            "This fallback hides a missing member behind \"{sentinel}\". Keep the missing value distinct from a reported value."
                        ),
                    ),
                );
            }
            return;
        }
        let expression = match node.kind() {
            Kind::ReturnStatement => node.as_return_statement().expression(),
            Kind::ArrowFunction => node.body().filter(|body| body.kind() != Kind::Block),
            _ => None,
        };
        let Some(expression) = expression else {
            return;
        };
        let name = function_name(node);
        if !detection_helper(&name) {
            return;
        }
        let Some(source) = recovery_source(node, expression) else {
            return;
        };
        ctx.report_node(
            without_parens(expression),
            RuleMessage::new(
                "noSilentEmptyFallback",
                format!(
                    "Do not return an empty string from {name} (source: {source}). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value."
                ),
            ),
        );
    }
}

fn string_literal(expression: P<Node>) -> Option<&'static str> {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::StringLiteral => Some(inner.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => Some(inner.text()),
        _ => None,
    }
}

fn contains_empty(expression: P<Node>) -> bool {
    if string_literal(expression) == Some("") {
        return true;
    }
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            match bin.operator_token().kind() {
                Kind::AmpersandAmpersandToken
                | Kind::BarBarToken
                | Kind::QuestionQuestionToken
                | Kind::CommaToken => contains_empty(bin.left()) || contains_empty(bin.right()),
                _ => false,
            }
        }
        Kind::ConditionalExpression => {
            let conditional = inner.as_conditional_expression();
            contains_empty(conditional.when_true()) || contains_empty(conditional.when_false())
        }
        _ => false,
    }
}

fn fallback_source(expression: P<Node>) -> Option<&'static str> {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            match bin.operator_token().kind() {
                Kind::BarBarToken | Kind::QuestionQuestionToken if contains_empty(bin.right()) => {
                    Some("ast-logical-fallback")
                }
                Kind::CommaToken => fallback_source(bin.right()),
                _ => None,
            }
        }
        Kind::ConditionalExpression => {
            let conditional = inner.as_conditional_expression();
            (contains_empty(conditional.when_true()) || contains_empty(conditional.when_false()))
                .then_some("ast-conditional-fallback")
        }
        _ => None,
    }
}

fn failure_test(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::PrefixUnaryExpression => {
            inner.as_prefix_unary_expression().operator() == Kind::ExclamationToken
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            match bin.operator_token().kind() {
                Kind::EqualsEqualsToken
                | Kind::EqualsEqualsEqualsToken
                | Kind::ExclamationEqualsToken
                | Kind::ExclamationEqualsEqualsToken => true,
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken => {
                    failure_test(bin.left()) || failure_test(bin.right())
                }
                _ => false,
            }
        }
        _ => false,
    }
}

fn recovery_source(node: P<Node>, expression: P<Node>) -> Option<&'static str> {
    if let Some(source) = fallback_source(expression) {
        return Some(source);
    }
    if !contains_empty(expression) {
        return None;
    }
    let mut ancestors = Vec::new();
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if is_function(ancestor) {
            break;
        }
        ancestors.push(ancestor);
        cursor = ancestor.parent();
    }
    if ancestors.iter().any(|a| a.kind() == Kind::CatchClause) {
        return Some("ast-catch-recovery");
    }
    let nearest_if = ancestors
        .iter()
        .copied()
        .find(|a| a.kind() == Kind::IfStatement);
    if nearest_if.is_some_and(|branch| failure_test(branch.as_if_statement().expression())) {
        return Some("ast-failure-branch");
    }
    let direct = node.kind() == Kind::ArrowFunction
        || node
            .parent()
            .and_then(|parent| parent.parent())
            .is_some_and(is_function);
    (direct && string_literal(expression) == Some("")).then_some("ast-direct-empty")
}

fn function_name(node: P<Node>) -> String {
    let mut cursor = Some(node);
    let mut function = None;
    while let Some(current) = cursor {
        if is_function(current) {
            function = Some(current);
            break;
        }
        cursor = current.parent();
    }
    let Some(function) = function else {
        return String::new();
    };
    if function.kind() == Kind::FunctionDeclaration {
        return function
            .name()
            .and_then(|n| ast::is_identifier(n).then(|| n.as_identifier().text().to_string()))
            .unwrap_or_default();
    }
    if matches!(
        function.kind(),
        Kind::MethodDeclaration | Kind::GetAccessor | Kind::SetAccessor
    ) {
        return function
            .name()
            .and_then(property_name)
            .map(str::to_string)
            .unwrap_or_default();
    }
    let Some(parent) = function.parent() else {
        return String::new();
    };
    match parent.kind() {
        Kind::VariableDeclaration | Kind::PropertyAssignment | Kind::PropertyDeclaration => parent
            .name()
            .and_then(property_name)
            .map(str::to_string)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn detection_helper(name: &str) -> bool {
    let tokens = split_identifier_words(name);
    !tokens
        .iter()
        .any(|token| ["display", "format", "render"].contains(&token.as_str()))
        && tokens.iter().any(|token| {
            [
                "detect", "discover", "host", "hostname", "identity", "lookup", "machine",
                "platform", "probe", "trace", "uuid", "device",
            ]
            .contains(&token.as_str())
        })
}
