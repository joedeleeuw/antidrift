use super::RustDiagnostic;
use super::syn_ast::{call_path_ends_with, extract_pat_ident};
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Arm, Expr, ExprClosure, ExprIf, ExprMethodCall, ImplItemFn, ItemFn, Local, Pat, Stmt};

pub(super) fn check_error_handling(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    ErrorHandlingVisitor {
        rel_path,
        error_bindings: FxHashSet::default(),
        error_string_bindings: FxHashSet::default(),
        diagnostics,
    }
    .visit_file(ast);
}

struct ErrorHandlingVisitor<'a> {
    rel_path: &'a str,
    error_bindings: FxHashSet<String>,
    error_string_bindings: FxHashSet<String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl ErrorHandlingVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message.into(),
        ));
    }

    fn visit_fn_scope(&mut self, body: impl FnOnce(&mut Self)) {
        let prev = (
            std::mem::take(&mut self.error_bindings),
            std::mem::take(&mut self.error_string_bindings),
        );
        body(self);
        (self.error_bindings, self.error_string_bindings) = prev;
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

impl<'ast> Visit<'ast> for ErrorHandlingVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        self.visit_fn_scope(|this| visit::visit_item_fn(this, node));
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        self.visit_fn_scope(|this| visit::visit_impl_item_fn(this, node));
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

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if node.method == "map_err"
            && node.args.len() == 1
            && let Expr::Closure(closure) = &node.args[0]
            && stringifies_closure_error_param(closure)
        {
            self.push(
                node.method.span(),
                "rust/no-anemic-errors",
                "'.map_err(...)' converts the source error to a bare string without adding boundary context; wrap in a typed error or include the operation/input that failed.",
            );
        }
        visit::visit_expr_method_call(self, node);
    }
}

fn peel_closure_expr(expr: &Expr) -> &Expr {
    match expr {
        Expr::Block(block) if block.block.stmts.len() == 1 => match &block.block.stmts[0] {
            Stmt::Expr(inner, None) => peel_closure_expr(inner),
            _ => expr,
        },
        Expr::Paren(paren) => peel_closure_expr(&paren.expr),
        Expr::Group(group) => peel_closure_expr(&group.expr),
        other => other,
    }
}

fn stringifies_closure_error_param(closure: &ExprClosure) -> bool {
    if closure.inputs.len() != 1 {
        return false;
    }
    let Some((param_name, _)) = extract_pat_ident(&closure.inputs[0]) else {
        return false;
    };
    if param_name.starts_with('_') {
        return false;
    }
    match peel_closure_expr(&closure.body) {
        Expr::MethodCall(call) => {
            (call.method == "to_string" || call.method == "to_owned")
                && call.args.is_empty()
                && matches!(&*call.receiver, Expr::Path(path) if path.path.is_ident(&param_name))
        }
        Expr::Call(call) => {
            call_path_ends_with(call, &["String", "from"])
                && call.args.len() == 1
                && matches!(&call.args[0], Expr::Path(path) if path.path.is_ident(&param_name))
        }
        Expr::Macro(mac) if mac.mac.path.is_ident("format") => {
            let compact: String = mac
                .mac
                .tokens
                .to_string()
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .collect();
            compact == format!("\"{{{param_name}}}\"")
                || compact == format!("\"{{{param_name}:?}}\"")
                || compact == format!("\"{{}}\",{param_name}")
                || compact == format!("\"{{:?}}\",{param_name}")
        }
        _ => false,
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
            matches!(
                m.as_str(),
                "to_string" | "to_ascii_lowercase" | "to_lowercase" | "as_str" | "trim"
            ) && call.args.is_empty()
                && is_error_to_string_expr(&call.receiver, err_bindings, str_bindings)
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
