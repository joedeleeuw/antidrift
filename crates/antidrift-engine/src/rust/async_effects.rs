use super::RustDiagnostic;
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Expr, ExprCall, ExprMethodCall, ImplItemFn, ItemFn};

const ASYNC_RUNTIME_NAMESPACES: &[&str] = &["tokio", "async_std", "smol", "futures"];
const BLOCKING_OFFLOAD_CALLEES: &[&str] = &["spawn_blocking", "block_in_place"];
const SUBPROCESS_WAIT_METHODS: &[&str] = &["output", "status", "wait", "wait_with_output"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum BlockingCall {
    Sleep,
    Subprocess,
}

impl BlockingCall {
    fn label(self) -> &'static str {
        match self {
            Self::Sleep => "wall-clock sleep",
            Self::Subprocess => "synchronous subprocess wait",
        }
    }

    fn remedy(self) -> &'static str {
        match self {
            Self::Sleep => "await an async timer or a lifecycle signal",
            Self::Subprocess => {
                "await an async process runner or move the wait to a blocking-offload worker"
            }
        }
    }
}

fn blocking_call(callee_segments: &[&str]) -> Option<BlockingCall> {
    if callee_segments
        .iter()
        .any(|segment| ASYNC_RUNTIME_NAMESPACES.contains(segment))
    {
        return None;
    }
    if callee_segments.ends_with(&["thread", "sleep"]) {
        return Some(BlockingCall::Sleep);
    }
    callee_segments
        .ends_with(&["Command", "new"])
        .then_some(BlockingCall::Subprocess)
}

pub(super) fn check_async_effects(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    AsyncEffectVisitor {
        rel_path,
        in_async: false,
        offload_depth: 0,
        awaited_chain: FxHashSet::default(),
        diagnostics,
    }
    .visit_file(ast);
}

struct AsyncEffectVisitor<'a> {
    rel_path: &'a str,
    in_async: bool,
    offload_depth: usize,
    awaited_chain: FxHashSet<(usize, usize)>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl AsyncEffectVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message,
        ));
    }

    fn report_blocking(&mut self, span: Span, kind: BlockingCall, callee: &str) {
        self.push(
            span,
            "rust/no-blocking-in-async",
            format!(
                "{} '{callee}' inside an async context blocks the executor thread; {}.",
                kind.label(),
                kind.remedy()
            ),
        );
    }

    fn with_async(&mut self, is_async: bool, body: impl FnOnce(&mut Self)) {
        let previous = self.in_async;
        self.in_async = is_async;
        body(self);
        self.in_async = previous;
    }
}

impl<'ast> Visit<'ast> for AsyncEffectVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        self.with_async(node.sig.asyncness.is_some(), |this| {
            visit::visit_item_fn(this, node);
        });
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        self.with_async(node.sig.asyncness.is_some(), |this| {
            visit::visit_impl_item_fn(this, node);
        });
    }

    fn visit_expr_async(&mut self, node: &'ast syn::ExprAsync) {
        self.with_async(true, |this| visit::visit_expr_async(this, node));
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        let is_async = node.asyncness.is_some() || self.in_async;
        self.with_async(is_async, |this| visit::visit_expr_closure(this, node));
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        let segments = callee_segments(&node.func);
        let names: Vec<&str> = segments.iter().map(String::as_str).collect();
        if names
            .last()
            .is_some_and(|name| BLOCKING_OFFLOAD_CALLEES.contains(name))
        {
            self.offload_depth += 1;
            visit::visit_expr_call(self, node);
            self.offload_depth -= 1;
            return;
        }
        if self.in_async
            && self.offload_depth == 0
            && let Some(kind) = blocking_call(&names)
            && kind != BlockingCall::Subprocess
        {
            self.report_blocking(node.func.span(), kind, &names.join("::"));
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_await(&mut self, node: &'ast syn::ExprAwait) {
        let mut cursor: &Expr = &node.base;
        loop {
            match cursor {
                Expr::MethodCall(call) => {
                    let start = call.method.span().start();
                    self.awaited_chain.insert((start.line, start.column));
                    cursor = &call.receiver;
                }
                Expr::Try(tried) => cursor = &tried.expr,
                Expr::Paren(paren) => cursor = &paren.expr,
                Expr::Await(inner) => cursor = &inner.base,
                _ => break,
            }
        }
        visit::visit_expr_await(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let method = node.method.to_string();
        let start = node.method.span().start();
        if self.in_async
            && self.offload_depth == 0
            && !self.awaited_chain.contains(&(start.line, start.column))
            && SUBPROCESS_WAIT_METHODS.contains(&method.as_str())
            && receiver_root_blocking_call(&node.receiver) == Some(BlockingCall::Subprocess)
        {
            self.report_blocking(
                node.method.span(),
                BlockingCall::Subprocess,
                &format!(".{method}()"),
            );
        }
        visit::visit_expr_method_call(self, node);
    }
}

fn callee_segments(func: &Expr) -> Vec<String> {
    match func {
        Expr::Path(path) => path
            .path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn receiver_root_blocking_call(expr: &Expr) -> Option<BlockingCall> {
    match expr {
        Expr::MethodCall(call) => receiver_root_blocking_call(&call.receiver),
        Expr::Reference(reference) => receiver_root_blocking_call(&reference.expr),
        Expr::Call(call) => {
            let segments = callee_segments(&call.func);
            let names: Vec<&str> = segments.iter().map(String::as_str).collect();
            blocking_call(&names)
        }
        _ => None,
    }
}
