use super::RustDiagnostic;
use super::syn_ast::{call_path_ends_with, extract_pat_ident};
use antidrift_kernel::relational_scan::{
    is_cross_param_key_pair, is_inner_linear_scan_method, is_outer_traversal_method,
};
use antidrift_kernel::runtime_lifecycle::{
    has_hold_open_resource, is_inline_hold_open_script, is_script_binding_name,
};
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    BinOp, Expr, ExprBinary, ExprCall, ExprClosure, ExprField, ExprForLoop, ExprLit,
    ExprMethodCall, ImplItemFn, ItemFn, Lit, Local,
};

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
        script_context: false,
        offload_depth: 0,
        awaited_chain: FxHashSet::default(),
        outer_loop_params: Vec::new(),
        diagnostics,
    }
    .visit_file(ast);
}

struct AsyncEffectVisitor<'a> {
    rel_path: &'a str,
    in_async: bool,
    script_context: bool,
    offload_depth: usize,
    awaited_chain: FxHashSet<(usize, usize)>,
    outer_loop_params: Vec<String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl AsyncEffectVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message.into(),
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

    fn visit_expr_closure(&mut self, node: &'ast ExprClosure) {
        let is_async = node.asyncness.is_some() || self.in_async;
        self.with_async(is_async, |this| visit::visit_expr_closure(this, node));
    }

    fn visit_local(&mut self, node: &'ast Local) {
        let previous = self.script_context;
        self.script_context =
            extract_pat_ident(&node.pat).is_some_and(|(name, _)| is_script_binding_name(&name));
        visit::visit_local(self, node);
        self.script_context = previous;
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        let previous = self.script_context;
        self.script_context = is_script_binding_name(&node.ident.to_string());
        visit::visit_item_const(self, node);
        self.script_context = previous;
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        let previous = self.script_context;
        self.script_context = is_script_binding_name(&node.ident.to_string());
        visit::visit_item_static(self, node);
        self.script_context = previous;
    }

    fn visit_expr_for_loop(&mut self, node: &'ast ExprForLoop) {
        let pushed = extract_pat_ident(&node.pat).map(|(name, _)| name);
        if let Some(ref name) = pushed {
            self.outer_loop_params.push(name.clone());
        }
        visit::visit_expr_for_loop(self, node);
        if pushed.is_some() {
            self.outer_loop_params.pop();
        }
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
        let previous = self.script_context;
        self.script_context |= call_path_ends_with(node, &["Command", "new"]);
        visit::visit_expr_call(self, node);
        self.script_context = previous;
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
        if is_outer_traversal_method(&method)
            && let Some(Expr::Closure(closure)) = node.args.first()
            && let Some(param_name) = first_closure_param_name(closure)
        {
            self.outer_loop_params.push(param_name);
            visit::visit_expr_method_call(self, node);
            self.outer_loop_params.pop();
            return;
        }
        if is_inner_linear_scan_method(&method)
            && !self.outer_loop_params.is_empty()
            && let Some(Expr::Closure(closure)) = node.args.first()
            && let Some(inner_param) = first_closure_param_name(closure)
            && receiver_is_outer_collection(&node.receiver, &self.outer_loop_params)
            && self.outer_loop_params.iter().any(|outer| {
                outer != &inner_param
                    && closure_has_field_key_equality(&closure.body, outer, &inner_param)
            })
        {
            self.push(
                node.method.span(),
                "rust/no-query-join-or-tree-reshape",
                format!(
                    "Nested '.{method}(...)' performs an O(N*M) linear key lookup inside an outer traversal; pre-index the lookup collection by key."
                ),
            );
        }
        let previous = self.script_context;
        self.script_context |= node.method == "arg" || node.method == "args";
        visit::visit_expr_method_call(self, node);
        self.script_context = previous;
    }

    fn visit_expr_lit(&mut self, node: &'ast ExprLit) {
        if let Lit::Str(lit_str) = &node.lit
            && is_inline_hold_open_script(&lit_str.value())
            && (self.script_context || has_hold_open_resource(&lit_str.value()))
        {
            self.push(
                node.span(),
                "rust/no-blocking-in-async",
                "Inline child script uses a wall-clock sleep hold-open timer instead of parent-bound stdin EOF lifetime control.",
            );
        }
        visit::visit_expr_lit(self, node);
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

fn first_closure_param_name(closure: &ExprClosure) -> Option<String> {
    extract_pat_ident(closure.inputs.first()?).map(|(name, _)| name)
}

fn receiver_is_outer_collection(expr: &Expr, outer_params: &[String]) -> bool {
    matches!(
        expr,
        Expr::MethodCall(mc)
            if (mc.method == "iter" || mc.method == "values")
                && root_ident_of(&mc.receiver).is_some_and(|r| !outer_params.contains(&r))
    )
}

fn root_ident_of(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Path(ep) => ep.path.get_ident().map(ToString::to_string),
        Expr::Field(ef) => root_ident_of(&ef.base),
        Expr::Reference(er) => root_ident_of(&er.expr),
        _ => None,
    }
}

fn field_access_root(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Field(ExprField { base, .. }) => match &**base {
            Expr::Path(ep) => ep.path.get_ident().map(ToString::to_string),
            _ => None,
        },
        Expr::Reference(er) => field_access_root(&er.expr),
        Expr::MethodCall(mc) if mc.method == "as_str" && mc.args.is_empty() => {
            field_access_root(&mc.receiver)
        }
        _ => None,
    }
}

fn closure_has_field_key_equality(expr: &Expr, outer_param: &str, inner_param: &str) -> bool {
    match expr {
        Expr::Binary(ExprBinary {
            left,
            op: BinOp::Eq(_),
            right,
            ..
        }) => {
            is_cross_param_key_pair(
                field_access_root(left).as_deref(),
                field_access_root(right).as_deref(),
                outer_param,
                inner_param,
            ) || closure_has_field_key_equality(left, outer_param, inner_param)
                || closure_has_field_key_equality(right, outer_param, inner_param)
        }
        Expr::Binary(bin) => {
            closure_has_field_key_equality(&bin.left, outer_param, inner_param)
                || closure_has_field_key_equality(&bin.right, outer_param, inner_param)
        }
        Expr::Block(b) => b.block.stmts.iter().any(|stmt| match stmt {
            syn::Stmt::Expr(e, _) => closure_has_field_key_equality(e, outer_param, inner_param),
            _ => false,
        }),
        _ => false,
    }
}
