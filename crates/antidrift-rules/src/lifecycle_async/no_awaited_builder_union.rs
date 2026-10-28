use super::syntax::{Span, in_scope, member, unwrap, without_parens};
use antidrift_kernel::directives::scan_source_comments;
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-awaited-builder-union";

#[derive(PartialEq, Eq)]
enum ChainStep {
    Call,
    Property(String),
    Computed,
}

struct BuilderChain {
    root: String,
    steps: Vec<ChainStep>,
}

pub struct NoAwaitedBuilderUnion {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAwaitedBuilderUnion = NoAwaitedBuilderUnion {
    scope: RuleScope::DEFAULT,
};

impl NoAwaitedBuilderUnion {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::AwaitExpression)];

impl Rule for NoAwaitedBuilderUnion {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: in_scope(ctx, &self.scope),
        })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let argument = node.as_await_expression().expression();
        if unwrap(argument).kind() != Kind::ConditionalExpression {
            return;
        }
        let mut branches = Vec::new();
        collect_branches(argument, &mut branches);
        let Some(chains) = branches
            .iter()
            .copied()
            .map(describe_chain)
            .collect::<Option<Vec<_>>>()
        else {
            return;
        };
        let Some(first) = chains.first() else {
            return;
        };
        if chains.iter().any(|chain| chain.root != first.root) || !has_chain_union(&chains) {
            return;
        }
        let message = RuleMessage::new(
            "awaitedBuilderUnion",
            format!(
                "Awaiting a ternary over two chain states of `{root}` makes TypeScript instantiate both builder types and their union before it can resolve `Awaited<>` over it, which is charged against the typecheck-cost baseline. Await inside each branch instead (`cond ? await {root}.chain() : await {root}`): the condition is evaluated first either way, so the rewrite preserves semantics and resolves one concrete type at a time.",
                root = first.root
            ),
        );
        if let Some(edits) = builder_fix(ctx, node, argument, &branches) {
            ctx.report_node_with_fixes(node, message, |ctx| {
                edits
                    .into_iter()
                    .map(|(start, end, text)| ctx.fix_replace_range(start, end, text))
                    .collect()
            });
        } else {
            ctx.report_node(node, message);
        }
    }
}

fn collect_branches(expression: P<Node>, branches: &mut Vec<P<Node>>) {
    let inner = unwrap(expression);
    if inner.kind() == Kind::ConditionalExpression {
        let conditional = inner.as_conditional_expression();
        collect_branches(conditional.when_true(), branches);
        collect_branches(conditional.when_false(), branches);
    } else {
        branches.push(expression);
    }
}

fn describe_chain(expression: P<Node>) -> Option<BuilderChain> {
    let mut current = unwrap(expression);
    let mut steps = Vec::new();
    loop {
        match current.kind() {
            Kind::Identifier => {
                steps.reverse();
                return Some(BuilderChain {
                    root: current.as_identifier().text().to_string(),
                    steps,
                });
            }
            Kind::ThisKeyword => {
                steps.reverse();
                return Some(BuilderChain {
                    root: "this".to_string(),
                    steps,
                });
            }
            Kind::CallExpression => {
                steps.push(ChainStep::Call);
                current = unwrap(current.as_call_expression().expression());
            }
            Kind::ElementAccessExpression => {
                let computed = current.as_element_access_expression();
                let arg = unwrap(computed.argument_expression());
                let property = if arg.kind() == Kind::NoSubstitutionTemplateLiteral {
                    Some(arg.text().to_string())
                } else {
                    member(current).map(|(_, name)| name.to_string())
                };
                steps.push(property.map_or(ChainStep::Computed, ChainStep::Property));
                current = unwrap(computed.expression());
            }
            _ => {
                let (object, name) = member(current)?;
                steps.push(ChainStep::Property(name.to_string()));
                current = unwrap(object);
            }
        }
    }
}

fn has_chain_union(chains: &[BuilderChain]) -> bool {
    chains.iter().any(|chain| {
        chains.iter().any(|other| {
            chain.steps.len() < other.steps.len() && other.steps.starts_with(&chain.steps)
        })
    })
}

fn has_optional_chain(expression: P<Node>) -> bool {
    let mut found = match expression.kind() {
        Kind::PropertyAccessExpression => expression
            .as_property_access_expression()
            .question_dot_token()
            .is_some(),
        Kind::ElementAccessExpression => expression
            .as_element_access_expression()
            .question_dot_token()
            .is_some(),
        Kind::CallExpression => expression
            .as_call_expression()
            .question_dot_token()
            .is_some(),
        _ => false,
    };
    if found {
        return true;
    }
    expression.for_each_child(&mut |child| {
        if has_optional_chain(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn unsafe_wrapper(expression: P<Node>) -> bool {
    match expression.kind() {
        Kind::ParenthesizedExpression => {
            unsafe_wrapper(expression.as_parenthesized_expression().expression())
        }
        Kind::ConditionalExpression => {
            let conditional = expression.as_conditional_expression();
            unsafe_wrapper(conditional.when_true()) || unsafe_wrapper(conditional.when_false())
        }
        Kind::AsExpression
        | Kind::SatisfiesExpression
        | Kind::NonNullExpression
        | Kind::ExpressionWithTypeArguments => true,
        _ => has_optional_chain(expression),
    }
}

fn builder_fix(
    ctx: &Ctx<'_>,
    awaited: P<Node>,
    argument: P<Node>,
    branches: &[P<Node>],
) -> Option<Vec<(i32, i32, &'static str)>> {
    if unsafe_wrapper(argument) {
        return None;
    }
    let span = Span::of(ctx.file, awaited);
    let arg_span = Span::of(ctx.file, unwrap(argument));
    let await_end = span.start + 5;
    let source_text = ctx.file.text();
    if scan_source_comments(source_text)
        .iter()
        .any(|comment| comment.pos >= await_end && comment.pos < arg_span.start)
    {
        return None;
    }
    let Ok(await_end_index) = usize::try_from(await_end) else {
        return None;
    };
    let trailing = source_text.get(await_end_index..)?;
    let whitespace = trailing.len() - trailing.trim_start().len();
    let Ok(whitespace_length) = i32::try_from(whitespace) else {
        return None;
    };
    let removal_end = await_end.checked_add(whitespace_length)?;
    let mut edits = vec![(span.start, removal_end, "")];
    edits.extend(branches.iter().map(|&branch| {
        let start = Span::of(ctx.file, without_parens(branch)).start;
        (start, start, "await ")
    }));
    Some(edits)
}
