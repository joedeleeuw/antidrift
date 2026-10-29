use super::RustDiagnostic;
use super::expression_shapes::{
    block_mentions_modified, closure_has_field_key_equality, collect_string_literals,
    detect_fieldwise_clone_rebuild, first_closure_param_name, is_multi_tier_exists_find,
    outcome_arm, receiver_is_outer_collection,
};
use super::syn_kernel::{call_path_ends_with, extract_pat_ident};
use antidrift_kernel::outcome_shape::{OutcomeArm, find_sum_to_product_pair};
use antidrift_kernel::relational_scan::{is_inner_linear_scan_method, is_outer_traversal_method};
use antidrift_kernel::runtime_lifecycle::{
    has_hold_open_resource, is_inline_hold_open_script, is_script_binding_name,
};
use proc_macro2::Span;
use rustc_hash::{FxHashMap, FxHashSet};
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Arm, Expr, ExprCall, ExprForLoop, ExprIf, ExprLit, ExprMethodCall, ExprStruct, ImplItemFn,
    ItemFn, Lit, Local, Pat,
};

pub(super) fn check_corpus_smells(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut visitor = CorpusSmellVisitor {
        rel_path,
        fn_has_mtime_check: false,
        script_context: false,
        error_bindings: FxHashSet::default(),
        error_string_bindings: FxHashSet::default(),
        local_string_lists: FxHashMap::default(),
        outer_loop_params: Vec::new(),
        outcome_arms: Vec::new(),
        diagnostics,
    };
    visitor.visit_file(ast);
}

struct CorpusSmellVisitor<'a> {
    rel_path: &'a str,
    fn_has_mtime_check: bool,
    script_context: bool,
    error_bindings: FxHashSet<String>,
    error_string_bindings: FxHashSet<String>,
    local_string_lists: FxHashMap<String, Vec<String>>,
    outer_loop_params: Vec<String>,
    outcome_arms: Vec<(OutcomeArm, Span)>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl CorpusSmellVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message.into(),
        ));
    }

    fn visit_fn_scope(&mut self, has_mtime: bool, body: impl FnOnce(&mut Self)) {
        let prev = (
            self.fn_has_mtime_check,
            std::mem::take(&mut self.error_bindings),
            std::mem::take(&mut self.error_string_bindings),
            std::mem::take(&mut self.local_string_lists),
            std::mem::take(&mut self.outcome_arms),
        );
        self.fn_has_mtime_check = has_mtime;
        body(self);
        self.report_sum_to_product_arms();
        (
            self.fn_has_mtime_check,
            self.error_bindings,
            self.error_string_bindings,
            self.local_string_lists,
            self.outcome_arms,
        ) = prev;
    }

    fn report_sum_to_product_arms(&mut self) {
        let arms: Vec<OutcomeArm> = self
            .outcome_arms
            .iter()
            .map(|(arm, _)| arm.clone())
            .collect();
        let Some((ok_index, err_index)) = find_sum_to_product_pair(&arms) else {
            return;
        };
        let ok_line = self.outcome_arms[ok_index].1.start().line.max(1);
        let (err_arm, err_span) = &self.outcome_arms[err_index];
        let record = err_arm
            .shape
            .split('{')
            .next()
            .unwrap_or_default()
            .to_owned();
        self.push(
            *err_span,
            "rust/no-contract-appeasement-projection",
            format!(
                "Success and failure arms (lines {ok_line} and {}) both build '{record}' with complementary flag and error fields; return a typed outcome enum or Result instead of a product bag.",
                err_span.start().line.max(1)
            ),
        );
    }

    fn check_error_string_branch(&mut self, expr: &Expr) {
        if expr_tests_error_string(expr, &self.error_bindings, &self.error_string_bindings) {
            self.push(
                expr.span(),
                "rust/no-anemic-errors",
                "Control flow branches on formatted error text ('.to_string().contains(...)'); preserve and match a typed error enum variant instead.",
            );
        }
    }
}

impl<'ast> Visit<'ast> for CorpusSmellVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        let has_mtime = block_mentions_modified(&node.block);
        self.visit_fn_scope(has_mtime, |this| {
            visit::visit_item_fn(this, node);
        });
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        let has_mtime = block_mentions_modified(&node.block);
        self.visit_fn_scope(has_mtime, |this| {
            visit::visit_impl_item_fn(this, node);
        });
    }

    fn visit_arm(&mut self, node: &'ast Arm) {
        let prev = (
            self.error_bindings.clone(),
            self.error_string_bindings.clone(),
        );
        if let Some(err_ident) = extract_err_binding_ident(&node.pat) {
            self.error_bindings.insert(err_ident);
        }
        if let Some((_, guard_expr)) = &node.guard {
            self.check_error_string_branch(guard_expr);
        }
        visit::visit_arm(self, node);
        (self.error_bindings, self.error_string_bindings) = prev;
    }

    fn visit_local(&mut self, node: &'ast Local) {
        if let Some(local_ident) = extract_pat_ident(&node.pat).map(|(name, _)| name)
            && let Some(init) = &node.init
        {
            if is_error_to_string_expr(
                &init.expr,
                &self.error_bindings,
                &self.error_string_bindings,
            ) {
                self.error_string_bindings.insert(local_ident.clone());
            }
            let mut lits = Vec::new();
            collect_string_literals(&init.expr, &mut lits);
            if lits.len() >= 2 {
                self.local_string_lists.insert(local_ident, lits);
            }
        }
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

    fn visit_expr_if(&mut self, node: &'ast ExprIf) {
        let prev_err = self.error_bindings.clone();
        if let Expr::Let(expr_let) = &*node.cond
            && let Some(err_ident) = extract_err_binding_ident(&expr_let.pat)
        {
            self.error_bindings.insert(err_ident);
        }
        self.check_error_string_branch(&node.cond);
        visit::visit_expr_if(self, node);
        self.error_bindings = prev_err;
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

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let method = node.method.to_string();
        if is_fs_read_to_string_sentinel(node) {
            self.push(
                node.method.span(),
                "rust/no-silent-result-discard",
                "fs::read_to_string failure is collapsed into \"\" via fallback, erasing the distinction between missing file and empty file; propagate the io::Error or return Option<String>.".to_owned(),
            );
        }
        if method == "find"
            && !self.fn_has_mtime_check
            && is_multi_tier_exists_find(node, &self.local_string_lists)
        {
            self.push(
                node.method.span(),
                "rust/no-silent-result-discard",
                "First-match '.find(|p| p.exists())' spans multiple build output tiers (debug/release/dist) without comparing modification times; sort candidates by metadata().modified() so stale build tiers do not shadow newer builds.",
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

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        let previous = self.script_context;
        self.script_context |= call_path_ends_with(node, &["Command", "new"]);
        visit::visit_expr_call(self, node);
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

    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        if let Some(arm) = outcome_arm(node) {
            self.outcome_arms.push((arm, node.path.span()));
        }
        if let Some(src_ident) = detect_fieldwise_clone_rebuild(node)
            && let Some(seg) = node.path.segments.last()
        {
            self.push(
                node.path.span(),
                "rust/no-contract-appeasement-projection",
                format!(
                    "Struct '{}' is rebuilt field-by-field via '.clone()' from '{src_ident}'; call '{src_ident}.clone()' directly.",
                    seg.ident
                ),
            );
        }
        visit::visit_expr_struct(self, node);
    }
}

fn extract_err_binding_ident(pat: &Pat) -> Option<String> {
    match pat {
        Pat::TupleStruct(ts)
            if ts.elems.len() == 1 && ts.path.segments.last().is_some_and(|s| s.ident == "Err") =>
        {
            extract_pat_ident(&ts.elems[0]).map(|(name, _)| name)
        }
        _ => None,
    }
}

fn is_error_to_string_expr(
    expr: &Expr,
    err_bindings: &FxHashSet<String>,
    str_bindings: &FxHashSet<String>,
) -> bool {
    match expr {
        Expr::MethodCall(call) => {
            let m = call.method.to_string();
            if matches!(
                m.as_str(),
                "to_string" | "to_ascii_lowercase" | "to_lowercase" | "as_str" | "trim"
            ) && call.args.is_empty()
            {
                return is_error_to_string_expr(&call.receiver, err_bindings, str_bindings);
            }
            false
        }
        Expr::Path(ep) => ep.path.get_ident().is_some_and(|id| {
            let s = id.to_string();
            err_bindings.contains(&s) || str_bindings.contains(&s)
        }),
        Expr::Reference(r) => is_error_to_string_expr(&r.expr, err_bindings, str_bindings),
        Expr::Paren(p) => is_error_to_string_expr(&p.expr, err_bindings, str_bindings),
        _ => false,
    }
}

fn expr_tests_error_string(
    expr: &Expr,
    err_bindings: &FxHashSet<String>,
    str_bindings: &FxHashSet<String>,
) -> bool {
    if err_bindings.is_empty() && str_bindings.is_empty() {
        return false;
    }
    match expr {
        Expr::MethodCall(call) => {
            let m = call.method.to_string();
            if matches!(m.as_str(), "contains" | "starts_with" | "ends_with")
                && call.args.len() == 1
                && is_error_to_string_expr(&call.receiver, err_bindings, str_bindings)
            {
                return true;
            }
            expr_tests_error_string(&call.receiver, err_bindings, str_bindings)
                || call
                    .args
                    .iter()
                    .any(|a| expr_tests_error_string(a, err_bindings, str_bindings))
        }
        Expr::Binary(bin) => {
            expr_tests_error_string(&bin.left, err_bindings, str_bindings)
                || expr_tests_error_string(&bin.right, err_bindings, str_bindings)
        }
        Expr::Unary(un) => expr_tests_error_string(&un.expr, err_bindings, str_bindings),
        Expr::Paren(p) => expr_tests_error_string(&p.expr, err_bindings, str_bindings),
        _ => false,
    }
}

fn is_fs_read_to_string_call(expr: &Expr) -> bool {
    matches!(expr, Expr::Call(call) if call_path_ends_with(call, &["fs", "read_to_string"]))
}

fn is_empty_string_expr(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) => s.value().is_empty(),
        Expr::Call(call) => call.args.is_empty() && call_path_ends_with(call, &["String", "new"]),
        Expr::MethodCall(c)
            if (c.method == "to_string" || c.method == "to_owned") && c.args.is_empty() =>
        {
            is_empty_string_expr(&c.receiver)
        }
        _ => false,
    }
}

fn is_fs_read_to_string_sentinel(node: &ExprMethodCall) -> bool {
    is_fs_read_to_string_call(&node.receiver)
        && ((node.method == "unwrap_or_default" && node.args.is_empty())
            || (node.method == "unwrap_or"
                && node.args.len() == 1
                && is_empty_string_expr(&node.args[0]))
            || (node.method == "unwrap_or_else"
                && matches!(node.args.first(), Some(Expr::Closure(c)) if is_empty_string_expr(&c.body))))
}
