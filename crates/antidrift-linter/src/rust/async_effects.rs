use super::RustDiagnostic;
use antidrift_kernel::async_effects::{
    IndependentAwaitRun, is_discard_binding_name, is_effect_callee_name,
};
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Block, Expr, ExprCall, ExprMethodCall, ImplItemFn, ItemFn, Local, Pat, Stmt};

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
        loop_depth: 0,
        offload_depth: 0,
        diagnostics,
    }
    .visit_file(ast);
}

struct AsyncEffectVisitor<'a> {
    rel_path: &'a str,
    in_async: bool,
    loop_depth: usize,
    offload_depth: usize,
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
        let previous = (self.in_async, self.loop_depth);
        self.in_async = is_async;
        self.loop_depth = 0;
        body(self);
        (self.in_async, self.loop_depth) = previous;
    }

    fn with_loop(&mut self, body: impl FnOnce(&mut Self)) {
        self.loop_depth += 1;
        body(self);
        self.loop_depth -= 1;
    }

    fn scan_await_run(&mut self, block: &Block) {
        let mut run = IndependentAwaitRun::<String>::default();
        for statement in &block.stmts {
            let Stmt::Local(local) = statement else {
                run.reset();
                continue;
            };
            let Some((declared, referenced)) = awaited_read(local) else {
                run.reset();
                continue;
            };
            let dependent = referenced.iter().any(|name| run.depends_on(name));
            if run.extend(declared, dependent) {
                self.push(
                    local.let_token.span,
                    "rust/no-query-join-or-tree-reshape",
                    "Three or more independent reads are awaited one after another; batch them with tokio::join! or futures::join! so they run concurrently.".to_owned(),
                );
            }
        }
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

    fn visit_expr_for_loop(&mut self, node: &'ast syn::ExprForLoop) {
        self.with_loop(|this| visit::visit_expr_for_loop(this, node));
    }

    fn visit_expr_while(&mut self, node: &'ast syn::ExprWhile) {
        self.with_loop(|this| visit::visit_expr_while(this, node));
    }

    fn visit_expr_loop(&mut self, node: &'ast syn::ExprLoop) {
        self.with_loop(|this| visit::visit_expr_loop(this, node));
    }

    fn visit_block(&mut self, node: &'ast Block) {
        if self.loop_depth == 0 {
            self.scan_await_run(node);
        }
        visit::visit_block(self, node);
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

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let method = node.method.to_string();
        if self.in_async
            && self.offload_depth == 0
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

fn peel_await_wrappers(expr: &Expr) -> &Expr {
    match expr {
        Expr::Try(tried) => peel_await_wrappers(&tried.expr),
        Expr::Paren(paren) => peel_await_wrappers(&paren.expr),
        Expr::Group(group) => peel_await_wrappers(&group.expr),
        inner => inner,
    }
}

fn awaited_read(local: &Local) -> Option<(Vec<String>, Vec<String>)> {
    let init = local.init.as_ref()?;
    let Expr::Await(awaited) = peel_await_wrappers(&init.expr) else {
        return None;
    };
    let callee = match peel_await_wrappers(&awaited.base) {
        Expr::Call(call) => callee_segments(&call.func).pop()?,
        Expr::MethodCall(call) => call.method.to_string(),
        _ => return None,
    };
    if is_effect_callee_name(&callee) {
        return None;
    }
    let declared: Vec<String> = declared_names(&local.pat)
        .into_iter()
        .filter(|name| !is_discard_binding_name(name))
        .collect();
    Some((declared, referenced_names(&awaited.base)))
}

fn declared_names(pat: &Pat) -> Vec<String> {
    struct Declared(Vec<String>);
    impl<'ast> Visit<'ast> for Declared {
        fn visit_pat_ident(&mut self, node: &'ast syn::PatIdent) {
            self.0.push(node.ident.to_string());
            visit::visit_pat_ident(self, node);
        }
    }
    let mut declared = Declared(Vec::new());
    declared.visit_pat(pat);
    declared.0
}

fn referenced_names(expr: &Expr) -> Vec<String> {
    struct Referenced(Vec<String>);
    impl<'ast> Visit<'ast> for Referenced {
        fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
            if let Some(first) = node.path.segments.first() {
                self.0.push(first.ident.to_string());
            }
            visit::visit_expr_path(self, node);
        }
    }
    let mut referenced = Referenced(Vec::new());
    referenced.visit_expr(expr);
    referenced.0
}
