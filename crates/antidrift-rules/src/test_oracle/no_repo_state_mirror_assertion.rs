use super::repo_state_imports::collect_tainted_imports;
use super::repo_state_taint::{literal_keyed_source_call, taint_root_name};
use antidrift_kernel::file_role::{ProjectPath, is_test_or_spec_file};
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-repo-state-mirror-assertion";

const EQUALITY_MATCHERS: &[&str] = &[
    "toBe",
    "toEqual",
    "toStrictEqual",
    "toMatchObject",
    "toContain",
    "toContainEqual",
    "toHaveProperty",
    "toMatch",
    "toMatchSnapshot",
    "toMatchInlineSnapshot",
];

const SNAPSHOT_MATCHERS: &[&str] = &["toMatchSnapshot", "toMatchInlineSnapshot"];

const EXISTENCE_MATCHERS: &[&str] = &[
    "toBeNull",
    "toBeUndefined",
    "toBeDefined",
    "toBeTruthy",
    "toBeFalsy",
];

const CHAIN_MODIFIERS: &[&str] = &["not", "resolves", "rejects"];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct RepoStateMirrorOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    sources: Vec<RepoStateSourceOption>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(super) struct RepoStateSourceOption {
    pub(super) module: String,
    pub(super) names: Option<Vec<String>>,
}

pub struct NoRepoStateMirrorAssertion {
    scope: RuleScope,
    sources: Vec<RepoStateSourceOption>,
}

pub static DEFAULT_RULE: NoRepoStateMirrorAssertion = NoRepoStateMirrorAssertion {
    scope: RuleScope::DEFAULT,
    sources: Vec::new(),
};

impl NoRepoStateMirrorAssertion {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<RepoStateMirrorOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            scope,
            sources: parsed.sources,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoRepoStateMirrorAssertion {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let normalized_path = ctx.file.file_name().replace('\\', "/");
        let path = ProjectPath::of(ctx.program, &normalized_path);
        let in_scope = self.scope.matches(&normalized_path, cwd)
            && (matches!(path.as_str(), "" | "<input>" | "<text>") || is_test_or_spec_file(&path));
        let tainted_imports = if in_scope {
            collect_tainted_imports(ctx.file.statements().nodes(), &self.sources)
        } else {
            FxHashMap::default()
        };
        Box::new(Visitor {
            enabled: in_scope,
            tainted_imports,
        })
    }
}

struct Visitor {
    enabled: bool,
    tainted_imports: FxHashMap<String, String>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_assertion_call(ctx, node, &self.tainted_imports);
    }
}

fn check_assertion_call(
    ctx: &mut Ctx<'_>,
    call_node: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
) {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return;
    }
    let access = callee.as_property_access_expression();
    let prop_node = access.name();
    if !ast::is_identifier(prop_node) {
        return;
    }
    let matcher = prop_node.as_identifier().text();
    let is_equality = EQUALITY_MATCHERS.contains(&matcher);
    let is_existence = EXISTENCE_MATCHERS.contains(&matcher);
    if !is_equality && !is_existence {
        return;
    }
    let Some(expect_call) = expect_call_of(access.expression()) else {
        return;
    };
    let Some(&subject_expr) = expect_call.as_call_expression().arguments().nodes().first() else {
        return;
    };
    if subject_expr.kind() == Kind::SpreadElement {
        return;
    }
    if is_equality {
        let args = call.arguments().nodes();
        let is_snapshot = SNAPSHOT_MATCHERS.contains(&matcher);
        if !is_snapshot && args.is_empty() {
            return;
        }
        if !args
            .iter()
            .all(|&arg| arg.kind() != Kind::SpreadElement && is_literal_like(arg))
        {
            return;
        }
        let mut visited_syms = FxHashSet::default();
        if let Some(name) = taint_root_name(subject_expr, tainted_imports, &mut visited_syms) {
            ctx.report_node(
                call_node,
                RuleMessage::new(
                    "mirroredLiteral",
                    format!(
                        "This assertion mirrors repo-owned state loaded through \"{name}\" against a literal. It restates values the repo already defines and breaks on every legitimate tune. Assert an invariant or behavior, or arrange the data as a fixture the test owns."
                    ),
                ),
            );
        }
        return;
    }
    if let Some(pinned) = literal_keyed_source_call(subject_expr, tainted_imports) {
        ctx.report_node(
            call_node,
            RuleMessage::new(
                "pinnedLookup",
                format!(
                    "This assertion pins the presence of a specific key in repo-owned state via \"{pinned}\". A row existing is data, not behavior. Assert an invariant, or arrange the data as a fixture the test owns."
                ),
            ),
        );
    }
}

fn expect_call_of(expr: P<Node>) -> Option<P<Node>> {
    let mut receiver = unwrap_expr(expr);
    while receiver.kind() == Kind::PropertyAccessExpression {
        let access = receiver.as_property_access_expression();
        let prop = access.name();
        if !ast::is_identifier(prop) || !CHAIN_MODIFIERS.contains(&prop.as_identifier().text()) {
            break;
        }
        receiver = unwrap_expr(access.expression());
    }
    if receiver.kind() != Kind::CallExpression {
        return None;
    }
    let call = receiver.as_call_expression();
    let callee = unwrap_expr(call.expression());
    (ast::is_identifier(callee)
        && callee.as_identifier().text() == "expect"
        && !call.arguments().nodes().is_empty())
    .then_some(receiver)
}

pub(super) fn unwrap_expr(mut expr: P<Node>) -> P<Node> {
    loop {
        match expr.kind() {
            Kind::ParenthesizedExpression => {
                expr = expr.as_parenthesized_expression().expression();
            }
            Kind::NonNullExpression => expr = expr.as_non_null_expression().expression(),
            Kind::AsExpression => expr = expr.as_as_expression().expression(),
            Kind::SatisfiesExpression => expr = expr.as_satisfies_expression().expression(),
            Kind::AwaitExpression => expr = expr.as_await_expression().expression(),
            _ => return expr,
        }
    }
}

pub(super) fn is_literal_like(expr: P<Node>) -> bool {
    let inner = unwrap_expr(expr);
    match inner.kind() {
        Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::NullKeyword
        | Kind::NumericLiteral
        | Kind::BigIntLiteral
        | Kind::RegularExpressionLiteral
        | Kind::StringLiteral
        | Kind::NoSubstitutionTemplateLiteral => true,
        Kind::Identifier => inner.as_identifier().text() == "undefined",
        Kind::PrefixUnaryExpression => {
            let unary = inner.as_prefix_unary_expression();
            matches!(unary.operator(), Kind::MinusToken | Kind::PlusToken)
                && is_literal_like(unary.operand())
        }
        Kind::ObjectLiteralExpression => inner
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .all(|&prop| match prop.kind() {
                Kind::PropertyAssignment => {
                    let assign = prop.as_property_assignment();
                    assign.name().kind() != Kind::ComputedPropertyName
                        && is_literal_like(assign.initializer())
                }
                Kind::ShorthandPropertyAssignment => {
                    is_literal_like(prop.as_shorthand_property_assignment().name())
                }
                _ => false,
            }),
        Kind::ArrayLiteralExpression => inner
            .as_array_literal_expression()
            .elements()
            .nodes()
            .iter()
            .all(|&elem| {
                !matches!(elem.kind(), Kind::SpreadElement | Kind::OmittedExpression)
                    && is_literal_like(elem)
            }),
        _ => false,
    }
}
