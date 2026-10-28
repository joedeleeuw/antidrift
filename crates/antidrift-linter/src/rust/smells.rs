use super::RustDiagnostic;
use proc_macro2::Span;
use std::path::Path;
use syn::visit::{self, Visit};
use syn::{
    Expr, ExprCall, ExprClosure, ExprMethodCall, ExprPath, FnArg, ItemEnum, ItemFn, ItemStruct,
    ItemType, Pat, Stmt,
};

pub(super) fn check_smells(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let is_rule_self = rel_path.ends_with("/no_compat_names.rs");
    if !is_rule_self
        && let Some(stem) = path.file_stem().and_then(|name| name.to_str())
        && has_banned_lifecycle_token(stem)
    {
        diagnostics.push(RustDiagnostic {
            file: rel_path.to_string(),
            line: 1,
            rule_id: "rust/no-compat-names",
            message: format!(
                "Module '{stem}' uses compatibility, retirement, or batch-scaffolding naming; name the module after the domain concept it owns."
            ),
        });
    }
    let mut visitor = SmellVisitor {
        rel_path,
        check_names: !is_rule_self,
        diagnostics,
    };
    visitor.visit_file(ast);
}

struct SmellVisitor<'a> {
    rel_path: &'a str,
    check_names: bool,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl SmellVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic {
            file: self.rel_path.to_string(),
            line: span.start().line.max(1),
            rule_id,
            message,
        });
    }

    fn check_ident_name(&mut self, name: &str, span: Span) {
        if self.check_names && has_banned_lifecycle_token(name) {
            self.push(
                span,
                "rust/no-compat-names",
                format!(
                    "'{name}' uses compatibility, retirement, or batch-scaffolding naming; delete the old path or name the item after its domain concept."
                ),
            );
        }
    }
}

impl<'ast> Visit<'ast> for SmellVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        let fn_name = node.sig.ident.to_string();
        self.check_ident_name(&fn_name, node.sig.ident.span());
        for input in &node.sig.inputs {
            if let FnArg::Typed(pat_type) = input
                && let Some((param_name, span)) = extract_pat_ident(&pat_type.pat)
            {
                self.check_ident_name(&param_name, span);
            }
        }
        if fn_name != "main"
            && let Some(callee) = detect_passthrough_wrapper(node)
        {
            self.push(
                node.sig.ident.span(),
                "rust/no-wrapping-functions",
                format!(
                    "Function '{fn_name}' is a pass-through wrapper around '{callee}'; call '{callee}' directly and delete '{fn_name}'."
                ),
            );
        }
        visit::visit_item_fn(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        self.check_ident_name(&node.ident.to_string(), node.ident.span());
        for field in &node.fields {
            if let Some(ident) = &field.ident {
                self.check_ident_name(&ident.to_string(), ident.span());
            }
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_item_enum(&mut self, node: &'ast ItemEnum) {
        self.check_ident_name(&node.ident.to_string(), node.ident.span());
        for variant in &node.variants {
            self.check_ident_name(&variant.ident.to_string(), variant.ident.span());
        }
        visit::visit_item_enum(self, node);
    }

    fn visit_item_type(&mut self, node: &'ast ItemType) {
        self.check_ident_name(&node.ident.to_string(), node.ident.span());
        visit::visit_item_type(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if node.method == "map_err"
            && node.args.len() == 1
            && let Expr::Closure(closure) = &node.args[0]
            && discards_closure_error_param(closure)
        {
            self.push(
                node.method.span(),
                "rust/no-anemic-errors",
                "'.map_err(|_| ...)' discards the underlying error cause; preserve or format the source error.".to_string(),
            );
        }
        visit::visit_expr_method_call(self, node);
    }
}

fn has_banned_lifecycle_token(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.contains("legacy")
        || lower.contains("deprecated")
        || lower.contains("retire")
        || lower.contains("nolonger")
        || lower.contains("no_longer")
    {
        return true;
    }
    let mut search_from = 0usize;
    while let Some(offset) = lower[search_from..].find("compat") {
        let abs = search_from + offset;
        if !lower[abs..].starts_with("compatible") {
            return true;
        }
        search_from = abs + 6;
    }
    has_numbered_prefix(&lower, "batch") || has_numbered_prefix(&lower, "slice_v")
}

fn has_numbered_prefix(lower: &str, prefix: &str) -> bool {
    let mut search_from = 0usize;
    while let Some(offset) = lower[search_from..].find(prefix) {
        let after = search_from + offset + prefix.len();
        let rest = &lower[after..];
        let trimmed = rest.strip_prefix('_').unwrap_or(rest);
        if trimmed.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            return true;
        }
        search_from = after;
    }
    false
}

fn extract_pat_ident(pat: &Pat) -> Option<(String, Span)> {
    match pat {
        Pat::Ident(pat_ident) => Some((pat_ident.ident.to_string(), pat_ident.ident.span())),
        Pat::Type(pat_type) => extract_pat_ident(&pat_type.pat),
        _ => None,
    }
}

fn discards_closure_error_param(closure: &ExprClosure) -> bool {
    if closure.inputs.len() != 1 {
        return false;
    }
    let pat = &closure.inputs[0];
    if is_wild_pat(pat) {
        return true;
    }
    let Some((param_name, _)) = extract_pat_ident(pat) else {
        return false;
    };
    !expr_mentions_ident(&closure.body, &param_name)
}

fn is_wild_pat(pat: &Pat) -> bool {
    match pat {
        Pat::Wild(_) => true,
        Pat::Type(pat_type) => is_wild_pat(&pat_type.pat),
        _ => false,
    }
}

struct IdentMentionVisitor<'a> {
    target: &'a str,
    found: bool,
}

impl<'ast> Visit<'ast> for IdentMentionVisitor<'_> {
    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        if node.path.is_ident(self.target) {
            self.found = true;
            return;
        }
        visit::visit_expr_path(self, node);
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        if node.tokens.to_string().contains(self.target) {
            self.found = true;
        }
        visit::visit_macro(self, node);
    }
}

fn expr_mentions_ident(expr: &Expr, target: &str) -> bool {
    let mut visitor = IdentMentionVisitor {
        target,
        found: false,
    };
    visitor.visit_expr(expr);
    visitor.found
}

fn detect_passthrough_wrapper(item_fn: &ItemFn) -> Option<String> {
    if item_fn.sig.inputs.is_empty() {
        return None;
    }
    let mut param_names = Vec::with_capacity(item_fn.sig.inputs.len());
    for input in &item_fn.sig.inputs {
        let FnArg::Typed(pat_type) = input else {
            return None;
        };
        let (name, _) = extract_pat_ident(&pat_type.pat)?;
        param_names.push(name);
    }
    if item_fn.block.stmts.len() != 1 {
        return None;
    }
    let expr = match &item_fn.block.stmts[0] {
        Stmt::Expr(expr, None) => expr,
        Stmt::Expr(Expr::Return(ret), _) => ret.expr.as_deref()?,
        _ => return None,
    };
    let Expr::Call(ExprCall { func, args, .. }) = expr else {
        return None;
    };
    if args.len() != param_names.len() {
        return None;
    }
    let Expr::Path(callee_path) = &**func else {
        return None;
    };
    for (arg, expected) in args.iter().zip(param_names.iter()) {
        let Expr::Path(arg_path) = arg else {
            return None;
        };
        if !arg_path.path.is_ident(expected) {
            return None;
        }
    }
    let segments: Vec<String> = callee_path
        .path
        .segments
        .iter()
        .map(|seg| seg.ident.to_string())
        .collect();
    if segments.last().is_some_and(|last| {
        last.chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase())
    }) {
        return None;
    }
    Some(segments.join("::"))
}
