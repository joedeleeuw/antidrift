use super::syntax::{
    Binding, Span, binding_for_declarator, identifier, identifier_member, parent_expression,
    references_to, without_parens,
};
use antidrift_kernel::rule_scope::decode_rule_options;
use serde::Deserialize;
use tsrs_ast::{Kind, ModifierFlags, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-async-array-method";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AsyncBranch {
    NeverAwait,
    RequiresCollection,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct AsyncArrayOptions {
    #[serde(deserialize_with = "decode_branches")]
    branches: Vec<AsyncBranch>,
}

fn decode_branches<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Vec<AsyncBranch>, D::Error> {
    let branches = Vec::<AsyncBranch>::deserialize(decoder)?;
    if branches.is_empty()
        || branches
            .iter()
            .enumerate()
            .any(|(index, branch)| branches[..index].contains(branch))
    {
        return Err(serde::de::Error::custom(
            "branches must contain distinct never-await or requires-collection entries and cannot be empty",
        ));
    }
    Ok(branches)
}

pub struct NoAsyncArrayMethod {
    requires_collection: bool,
}

pub static DEFAULT_RULE: NoAsyncArrayMethod = NoAsyncArrayMethod {
    requires_collection: false,
};

impl NoAsyncArrayMethod {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = decode_rule_options::<AsyncArrayOptions>(RULE_NAME, options)?;
        Ok(Self {
            requires_collection: decoded.branches.contains(&AsyncBranch::RequiresCollection),
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoAsyncArrayMethod {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            requires_collection: self.requires_collection,
        })
    }
}

struct Visitor {
    requires_collection: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let call = node.as_call_expression();
        let Some((_, method)) = identifier_member(call.expression()) else {
            return;
        };
        let Some(&first_arg) = call.arguments().nodes().first() else {
            return;
        };
        if first_arg.kind() == Kind::SpreadElement {
            return;
        }
        let callback = without_parens(first_arg);
        if !matches!(
            callback.kind(),
            Kind::ArrowFunction | Kind::FunctionExpression
        ) || !callback.modifier_flags().intersects(ModifierFlags::Async)
        {
            return;
        }
        if [
            "filter",
            "forEach",
            "some",
            "every",
            "find",
            "findIndex",
            "findLast",
            "findLastIndex",
            "sort",
        ]
        .contains(&method)
        {
            ctx.report_node(
                callback,
                RuleMessage::new(
                    "",
                    format!(
                        ".{method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop."
                    ),
                ),
            );
            return;
        }
        if !["map", "flatMap"].contains(&method) || !self.requires_collection {
            return;
        }
        if collected(ctx.file, node) {
            return;
        }
        ctx.report_node(
            callback,
            RuleMessage::new(
                "",
                format!(
                    "Wrap .{method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited."
                ),
            ),
        );
    }
}

fn combinator(call: P<Node>) -> bool {
    call.kind() == Kind::CallExpression
        && identifier_member(call.as_call_expression().expression()).is_some_and(
            |(object, method)| {
                identifier(object).is_some_and(|root| root.as_identifier().text() == "Promise")
                    && ["all", "allSettled", "race"].contains(&method)
            },
        )
}

fn returned(node: P<Node>) -> bool {
    let mut current = node;
    while let Some(ancestor) = current.parent() {
        let transparent = match ancestor.kind() {
            Kind::ReturnStatement => return true,
            Kind::ArrowFunction => {
                return ancestor
                    .body()
                    .is_some_and(|body| body.kind() != Kind::Block && body == current);
            }
            Kind::ConditionalExpression => {
                ancestor.as_conditional_expression().condition() != current
            }
            Kind::BinaryExpression => {
                let bin = ancestor.as_binary_expression();
                match bin.operator_token().kind() {
                    Kind::AmpersandAmpersandToken
                    | Kind::BarBarToken
                    | Kind::QuestionQuestionToken => true,
                    Kind::CommaToken => bin.right() == current,
                    _ => false,
                }
            }
            Kind::ParenthesizedExpression
            | Kind::AsExpression
            | Kind::TypeAssertionExpression
            | Kind::NonNullExpression => true,
            _ => false,
        };
        if !transparent {
            return false;
        }
        current = ancestor;
    }
    false
}

fn collected(sf: P<SourceFile>, call: P<Node>) -> bool {
    let outer = parent_expression(call);
    let Some(parent) = outer.parent() else {
        return false;
    };
    if (parent.kind() == Kind::CallExpression
        && parent.as_call_expression().expression() != outer
        && combinator(parent))
        || returned(call)
    {
        return true;
    }
    if parent.kind() != Kind::VariableDeclaration {
        return false;
    }
    let Some(binding) = binding_for_declarator(parent) else {
        return false;
    };
    handled_binding(sf, binding, Span::of(sf, call).end)
}

fn handled_binding(sf: P<SourceFile>, binding: Binding, after: i32) -> bool {
    references_to(sf.as_node(), binding)
        .into_iter()
        .any(|reference| {
            if Span::of(sf, reference).start < after {
                return false;
            }
            if returned(reference) {
                return true;
            }
            let Some(mut parent) = reference.parent() else {
                return false;
            };
            if parent.kind() == Kind::SpreadElement {
                let Some(next) = parent.parent() else {
                    return false;
                };
                parent = next;
            }
            parent.kind() == Kind::CallExpression
                && parent.as_call_expression().expression() != reference
                && combinator(parent)
        })
}
