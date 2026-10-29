use super::stream_origin::{canonical, is_stream};
use super::syntax::{
    Binding, Span, binding_for_declarator, call_expression_of, collect_binding_references,
    identifier_of, is_const_variable_declaration, is_function_like, is_write_reference, member,
    owner, parent_expression, resolve_lexical_binding,
};
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-stream-reader-disposal";

pub(super) struct ReaderAnalysis {
    pub(super) sf: P<SourceFile>,
    pub(super) binding: Binding,
    pub(super) root: P<Node>,
}

pub struct RequireStreamReaderDisposal {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireStreamReaderDisposal = RequireStreamReaderDisposal {
    scope: RuleScope::DEFAULT,
};

impl RequireStreamReaderDisposal {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireStreamReaderDisposal {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: self.scope.in_scope(ctx),
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
        let call = node.as_call_expression();
        let Some((stream, "getReader")) = member(call.expression()) else {
            return;
        };
        if !is_stream(stream) || directly_returned(node) {
            return;
        }
        let Some((binding, stable)) = acquisition_owner(node) else {
            ctx.report_node(node, disposal_message("releaseInFinally"));
            return;
        };
        let analysis = ReaderAnalysis {
            sf: ctx.file,
            binding,
            root: owner(node),
        };
        if stable && analysis.transferred(node) {
            return;
        }
        let Some(protecting) = analysis.protecting_try(node) else {
            ctx.report_node(node, disposal_message("releaseInFinally"));
            return;
        };
        let Some(finalizer) = protecting.as_try_statement().finally_block() else {
            return;
        };
        let release_end = finalizer
            .as_block()
            .statements()
            .nodes()
            .first()
            .map_or_else(
                || Span::of(ctx.file, finalizer).end,
                |&stmt| Span::of(ctx.file, stmt).end,
            );
        let call_end = Span::of(ctx.file, node).end;
        let mutated = collect_binding_references(ctx.file.as_node(), binding)
            .into_iter()
            .any(|reference| {
                let span = Span::of(ctx.file, reference);
                is_write_reference(reference) && span.start > call_end && span.start < release_end
            });
        if mutated {
            ctx.report_node(node, disposal_message("releaseInFinally"));
            return;
        }
        if !analysis.finalizer_cleanup(finalizer).cancels()
            && analysis.read_paths_require_cancel(protecting)
        {
            ctx.report_node(node, disposal_message("cancelBeforeRelease"));
        }
    }
}

fn disposal_message(id: &'static str) -> RuleMessage {
    let text = match id {
        "cancelBeforeRelease" => {
            "This ReadableStream reader can stop before EOF. Cancel it before releasing its lock so the producer is not left active."
        }
        _ => {
            "Release this ReadableStream reader's lock in a finally block, or explicitly return the reader to transfer ownership."
        }
    };
    RuleMessage::new(id, text)
}

fn acquisition_owner(node: P<Node>) -> Option<(Binding, bool)> {
    let parent = parent_expression(node).parent()?;
    match parent.kind() {
        Kind::VariableDeclaration => Some((
            binding_for_declarator(parent)?,
            is_const_variable_declaration(parent),
        )),
        Kind::BinaryExpression => {
            let bin = parent.as_binary_expression();
            if !ast::is_assignment_operator(bin.operator_token().kind())
                || bin.right() == bin.left()
            {
                return None;
            }
            Some((resolve_lexical_binding(identifier_of(bin.left())?)?, false))
        }
        _ => None,
    }
}

fn directly_returned(node: P<Node>) -> bool {
    let mut current = parent_expression(node);
    while let Some(parent) = current.parent() {
        if parent.kind() != Kind::AwaitExpression {
            break;
        }
        current = parent_expression(parent);
    }
    let Some(parent) = current.parent() else {
        return false;
    };
    matches!(parent.kind(), Kind::ReturnStatement | Kind::ArrowFunction)
}

impl ReaderAnalysis {
    pub(super) fn method(&self, expression: P<Node>, expected: &str) -> bool {
        let Some(call) = call_expression_of(expression) else {
            return false;
        };
        self.method_call(call, expected)
    }

    pub(super) fn method_call(&self, call_node: P<Node>, expected: &str) -> bool {
        member(call_node.as_call_expression().expression()).is_some_and(|(object, method)| {
            method == expected && canonical(object) == Some(self.binding)
        })
    }

    pub(super) fn nodes_within(&self, span: Span) -> Vec<P<Node>> {
        let mut out = Vec::new();
        self.collect_nodes_within(self.root, span, &mut out);
        out
    }

    fn collect_nodes_within(&self, node: P<Node>, span: Span, out: &mut Vec<P<Node>>) {
        if node != self.root && is_function_like(node) {
            return;
        }
        if span.contains_inclusive(Span::of(self.sf, node))
            && owner(node).pos() == self.root.pos()
            && owner(node).end() == self.root.end()
        {
            out.push(node);
        }
        node.for_each_child(&mut |child| {
            self.collect_nodes_within(child, span, out);
            false
        });
    }

    pub(super) fn statement_site(node: P<Node>) -> Option<(&'static [P<Node>], usize)> {
        let mut current = node;
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            let body: Option<&'static [P<Node>]> = match ancestor.kind() {
                Kind::SourceFile => Some(ancestor.as_source_file().statements().nodes()),
                Kind::Block => Some(ancestor.as_block().statements().nodes()),
                _ => None,
            };
            if let Some(body) = body {
                return body
                    .iter()
                    .position(|&stmt| stmt.pos() == current.pos() && stmt.end() == current.end())
                    .map(|index| (body, index));
            }
            current = ancestor;
            cursor = ancestor.parent();
        }
        None
    }

    fn protecting_try(&self, call: P<Node>) -> Option<P<Node>> {
        let call_span = Span::of(self.sf, call);
        self.nodes_within(Span::of(self.sf, self.root))
            .into_iter()
            .find_map(|node| {
                if node.kind() != Kind::TryStatement {
                    return None;
                }
                let protecting = node.as_try_statement();
                let finalizer = protecting.finally_block()?;
                if !self.finalizer_cleanup(finalizer).releases() {
                    return None;
                }
                if Span::of(self.sf, protecting.try_block()).contains_inclusive(call_span) {
                    return Some(node);
                }
                let (acquisition_body, acquisition_index) = Self::statement_site(call)?;
                let (try_body, try_index) = Self::statement_site(node)?;
                (std::ptr::eq(acquisition_body, try_body)
                    && try_index > acquisition_index
                    && self.safe_prefix(&try_body[acquisition_index + 1..try_index], false))
                .then_some(node)
            })
    }

    fn transferred(&self, call: P<Node>) -> bool {
        let Some((body, acquisition_index)) = Self::statement_site(call) else {
            return false;
        };
        let root_body: Option<&'static [P<Node>]> = if is_function_like(self.root) {
            self.root
                .body()
                .filter(|b| b.kind() == Kind::Block)
                .map(|b| b.as_block().statements().nodes())
        } else {
            None
        };
        if !root_body.is_some_and(|rb| std::ptr::eq(rb, body)) {
            return false;
        }
        let Some(&last_stmt) = body.last() else {
            return false;
        };
        if last_stmt.kind() != Kind::ReturnStatement {
            return false;
        }
        let returned_span = Span::of(self.sf, last_stmt);
        if last_stmt
            .as_return_statement()
            .expression()
            .and_then(canonical)
            != Some(self.binding)
            || !self.safe_prefix(&body[acquisition_index + 1..body.len() - 1], false)
        {
            return false;
        }
        !self
            .nodes_within(Span::of(self.sf, self.root))
            .into_iter()
            .any(|node| match node.kind() {
                Kind::ReturnStatement => Span::of(self.sf, node) != returned_span,
                Kind::ThrowStatement => true,
                Kind::CallExpression => ["cancel", "read", "releaseLock"]
                    .iter()
                    .any(|method| self.method_call(node, method)),
                _ => false,
            })
    }
}
