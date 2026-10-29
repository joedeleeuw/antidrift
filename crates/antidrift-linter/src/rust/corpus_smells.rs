use super::RustDiagnostic;
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Arm, BinOp, Expr, ExprBinary, ExprCall, ExprClosure, ExprField, ExprForLoop, ExprIf, ExprLit,
    ExprMatch, ExprMethodCall, ExprStruct, ImplItemFn, ItemFn, Lit, Local, Member, Pat,
};

pub(super) fn check_corpus_smells(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut visitor = CorpusSmellVisitor {
        rel_path,
        in_async_fn: false,
        error_bindings: FxHashSet::default(),
        error_string_bindings: FxHashSet::default(),
        outer_loop_params: Vec::new(),
        diagnostics,
    };
    visitor.visit_file(ast);
}

struct CorpusSmellVisitor<'a> {
    rel_path: &'a str,
    in_async_fn: bool,
    error_bindings: FxHashSet<String>,
    error_string_bindings: FxHashSet<String>,
    outer_loop_params: Vec<String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl CorpusSmellVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic {
            file: self.rel_path.to_owned(),
            line: span.start().line.max(1),
            rule_id,
            message: message.into(),
        });
    }

    fn visit_fn_scope(&mut self, is_async: bool, body: impl FnOnce(&mut Self)) {
        let prev = (
            self.in_async_fn,
            std::mem::take(&mut self.error_bindings),
            std::mem::take(&mut self.error_string_bindings),
        );
        self.in_async_fn = is_async;
        body(self);
        (
            self.in_async_fn,
            self.error_bindings,
            self.error_string_bindings,
        ) = prev;
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
        self.visit_fn_scope(node.sig.asyncness.is_some(), |this| {
            visit::visit_item_fn(this, node);
        });
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        self.visit_fn_scope(node.sig.asyncness.is_some(), |this| {
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
        if let Some(local_ident) = extract_pat_ident_name(&node.pat)
            && let Some(init) = &node.init
            && is_error_to_string_expr(
                &init.expr,
                &self.error_bindings,
                &self.error_string_bindings,
            )
        {
            self.error_string_bindings.insert(local_ident);
        }
        visit::visit_local(self, node);
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

    fn visit_expr_match(&mut self, node: &'ast ExprMatch) {
        if let Some(struct_name) = detect_result_sum_erasure_match(node) {
            self.push(
                node.match_token.span,
                "rust/no-constant-return-field",
                format!(
                    "Match erases Result Ok/Err arms into correlated boolean/Option fields on '{struct_name}'; keep a typed outcome enum or Result instead of a product bag."
                ),
            );
        }
        visit::visit_expr_match(self, node);
    }

    fn visit_expr_for_loop(&mut self, node: &'ast ExprForLoop) {
        let pushed = extract_pat_ident_name(&node.pat);
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
        if self.in_async_fn && is_sync_command_wait(&method, &node.receiver) {
            self.push(
                node.method.span(),
                "rust/no-wrapping-functions",
                format!(
                    "Synchronous std::process::Command '.{method}()' inside async fn blocks the executor thread; use an async process runner or spawn_blocking."
                ),
            );
        }
        if matches!(
            method.as_str(),
            "map" | "filter" | "filter_map" | "flat_map" | "for_each"
        ) && let Some(Expr::Closure(closure)) = node.args.first()
            && let Some(param_name) = first_closure_param_name(closure)
        {
            self.outer_loop_params.push(param_name);
            visit::visit_expr_method_call(self, node);
            self.outer_loop_params.pop();
            return;
        }
        if matches!(method.as_str(), "find" | "position" | "any")
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
                "rust/no-value-roundtrip",
                format!(
                    "Nested '.{method}(...)' performs an O(N*M) linear key lookup inside an outer traversal; pre-index the lookup collection by key."
                ),
            );
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if self.in_async_fn && is_std_thread_sleep_call(node) {
            self.push(
                node.func.span(),
                "rust/no-wrapping-functions",
                "Blocking 'std::thread::sleep' inside async fn stalls the async executor; await an async timer or lifecycle signal instead.".to_owned(),
            );
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_lit(&mut self, node: &'ast ExprLit) {
        if let Lit::Str(lit_str) = &node.lit
            && is_inline_hold_open_script(&lit_str.value())
        {
            self.push(
                node.span(),
                "rust/no-wrapping-functions",
                "Inline child script uses a wall-clock sleep hold-open timer instead of parent-bound stdin EOF lifetime control.",
            );
        }
        visit::visit_expr_lit(self, node);
    }

    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        if let Some(src_ident) = detect_fieldwise_clone_rebuild(node)
            && let Some(seg) = node.path.segments.last()
        {
            self.push(
                node.path.span(),
                "rust/no-value-roundtrip",
                format!(
                    "Struct '{}' is rebuilt field-by-field via '.clone()' from '{src_ident}'; call '{src_ident}.clone()' directly.",
                    seg.ident
                ),
            );
        }
        visit::visit_expr_struct(self, node);
    }
}

fn extract_pat_ident_name(pat: &Pat) -> Option<String> {
    match pat {
        Pat::Ident(pat_ident) => Some(pat_ident.ident.to_string()),
        Pat::Reference(pat_ref) => extract_pat_ident_name(&pat_ref.pat),
        Pat::Type(pat_type) => extract_pat_ident_name(&pat_type.pat),
        _ => None,
    }
}

fn extract_err_binding_ident(pat: &Pat) -> Option<String> {
    match pat {
        Pat::TupleStruct(ts)
            if ts.elems.len() == 1 && ts.path.segments.last().is_some_and(|s| s.ident == "Err") =>
        {
            extract_pat_ident_name(&ts.elems[0])
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

fn call_path_ends_with(call: &ExprCall, penult: &str, last: &str) -> bool {
    let Expr::Path(callee) = &*call.func else {
        return false;
    };
    let segs: Vec<_> = callee.path.segments.iter().map(|s| &s.ident).collect();
    segs.len() >= 2 && *segs[segs.len() - 2] == penult && *segs[segs.len() - 1] == last
}

fn is_fs_read_to_string_call(expr: &Expr) -> bool {
    matches!(expr, Expr::Call(call) if call_path_ends_with(call, "fs", "read_to_string"))
}

fn is_empty_string_expr(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) => s.value().is_empty(),
        Expr::Call(call) => call.args.is_empty() && call_path_ends_with(call, "String", "new"),
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

fn is_std_thread_sleep_call(call: &ExprCall) -> bool {
    call_path_ends_with(call, "thread", "sleep")
}

fn is_sync_command_wait(method: &str, receiver: &Expr) -> bool {
    matches!(method, "output" | "status" | "wait") && expr_mentions_std_command(receiver)
}

fn expr_mentions_std_command(expr: &Expr) -> bool {
    match expr {
        Expr::MethodCall(mc) => expr_mentions_std_command(&mc.receiver),
        Expr::Call(call) => {
            call_path_ends_with(call, "Command", "new")
                && matches!(&*call.func, Expr::Path(p) if !p.path.segments.iter().any(|s| s.ident == "tokio" || s.ident == "async_process"))
        }
        _ => false,
    }
}

fn is_inline_hold_open_script(text: &str) -> bool {
    (text.contains("print(") || text.contains("stdout.write"))
        && (text.contains("time.sleep(") || text.contains("setInterval("))
        && !text.contains("stdin")
}

fn first_closure_param_name(closure: &ExprClosure) -> Option<String> {
    extract_pat_ident_name(closure.inputs.first()?)
}

fn receiver_is_outer_collection(expr: &Expr, outer_params: &[String]) -> bool {
    matches!(expr, Expr::MethodCall(mc) if (mc.method == "iter" || mc.method == "values") && root_ident_of(&mc.receiver).is_some_and(|r| !outer_params.contains(&r)))
}

fn root_ident_of(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Path(ep) => ep.path.get_ident().map(ToString::to_string),
        Expr::Field(ef) => root_ident_of(&ef.base),
        Expr::Reference(er) => root_ident_of(&er.expr),
        _ => None,
    }
}

fn is_param_field_access(expr: &Expr, param: &str) -> bool {
    match expr {
        Expr::Field(ExprField { base, .. }) => {
            matches!(&**base, Expr::Path(ep) if ep.path.is_ident(param))
        }
        Expr::Reference(er) => is_param_field_access(&er.expr, param),
        Expr::MethodCall(mc) if mc.method == "as_str" && mc.args.is_empty() => {
            is_param_field_access(&mc.receiver, param)
        }
        _ => false,
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
            (is_param_field_access(left, outer_param) && is_param_field_access(right, inner_param))
                || (is_param_field_access(left, inner_param)
                    && is_param_field_access(right, outer_param))
                || closure_has_field_key_equality(left, outer_param, inner_param)
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

fn detect_result_sum_erasure_match(node: &ExprMatch) -> Option<String> {
    if node.arms.len() != 2 {
        return None;
    }
    let (mut ok_struct, mut err_struct) = (None, None);
    for arm in &node.arms {
        let Pat::TupleStruct(ts) = &arm.pat else {
            return None;
        };
        let variant = ts.path.segments.last()?.ident.to_string();
        let struct_expr = extract_arm_struct_expr(&arm.body)?;
        if variant == "Ok" {
            ok_struct = Some(struct_expr);
        } else if variant == "Err" {
            err_struct = Some(struct_expr);
        }
    }
    let (ok_s, err_s) = (ok_struct?, err_struct?);
    let ok_name = ok_s.path.segments.last()?.ident.to_string();
    if err_s.path.segments.last()?.ident != ok_name {
        return None;
    }
    (struct_has_bool_field(ok_s, true)
        && struct_has_bool_field(err_s, false)
        && struct_has_error_option_field(ok_s, false)
        && struct_has_error_option_field(err_s, true))
    .then_some(ok_name)
}

fn extract_arm_struct_expr(expr: &Expr) -> Option<&ExprStruct> {
    match expr {
        Expr::Struct(es) => Some(es),
        Expr::Block(b) => match b.block.stmts.last()? {
            syn::Stmt::Expr(Expr::Struct(es), None) => Some(es),
            _ => None,
        },
        _ => None,
    }
}

fn struct_has_bool_field(es: &ExprStruct, expected: bool) -> bool {
    es.fields.iter().any(
        |f| matches!(&f.expr, Expr::Lit(ExprLit { lit: Lit::Bool(b), .. }) if b.value == expected),
    )
}

fn struct_has_error_option_field(es: &ExprStruct, is_some: bool) -> bool {
    es.fields.iter().any(|f| {
        matches!(&f.member, Member::Named(id) if id == "error")
            && if is_some {
                matches!(&f.expr, Expr::Call(c) if matches!(&*c.func, Expr::Path(ep) if ep.path.is_ident("Some")))
            } else {
                matches!(&f.expr, Expr::Path(ep) if ep.path.is_ident("None"))
            }
    })
}

fn detect_fieldwise_clone_rebuild(node: &ExprStruct) -> Option<String> {
    if node.rest.is_some() || node.fields.len() < 3 {
        return None;
    }
    let (mut source_ident, mut clone_count) = (None, 0usize);
    for field in &node.fields {
        let Member::Named(field_ident) = &field.member else {
            return None;
        };
        let (base_ident, accessed_field, is_cloned) = extract_field_copy_or_clone(&field.expr)?;
        if *field_ident != accessed_field
            || source_ident.as_ref().is_some_and(|ex| ex != &base_ident)
        {
            return None;
        }
        source_ident = Some(base_ident);
        clone_count += usize::from(is_cloned);
    }
    (clone_count >= 2).then_some(source_ident?)
}

fn extract_field_copy_or_clone(expr: &Expr) -> Option<(String, String, bool)> {
    match expr {
        Expr::MethodCall(mc) if mc.method == "clone" && mc.args.is_empty() => {
            extract_field_copy_or_clone(&mc.receiver).map(|(b, f, _)| (b, f, true))
        }
        Expr::Field(ExprField {
            base,
            member: Member::Named(f),
            ..
        }) => match &**base {
            Expr::Path(ep) => Some((ep.path.get_ident()?.to_string(), f.to_string(), false)),
            _ => None,
        },
        _ => None,
    }
}
