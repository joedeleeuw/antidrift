use super::RustDiagnostic;
use super::async_effects::check_async_effects;
use super::corpus_smells::check_corpus_smells;
use super::discard_shapes::{
    DiscardedErrorOutcome, collect_cfg_used_bindings, discarded_error_outcome, is_cfg_attribute,
    stmt_has_cfg_attribute,
};
use super::lifecycle_names::{CrateNames, NameLedger, banned_lifecycle_message};
use super::syn_kernel::{
    call_path_ends_with, extract_pat_ident, is_err_wild_pat, is_fs_io_call, is_ok_tuple_pat,
    is_wild_pat,
};
use antidrift_kernel::declared_names::is_compat_name;
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use std::path::Path;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Arm, BinOp, Block, Expr, ExprBinary, ExprClosure, ExprField, ExprLet, ExprLit, ExprMethodCall,
    FnArg, ItemEnum, ItemFn, ItemStruct, ItemType, Lit, Member, Stmt,
};

pub(super) fn check_smells(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    crate_names: &CrateNames,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let is_rule_self = rel_path.ends_with("/declared_names.rs")
        || rel_path.ends_with("/no_compat_names.rs")
        || rel_path.ends_with("/naming_conventions.rs");
    if !is_rule_self
        && let Some(stem) = path.file_stem().and_then(|name| name.to_str())
        && (is_compat_name(stem) || banned_lifecycle_message(stem).is_some())
    {
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            1,
            "rust/no-compat-names",
            format!(
                "Module '{stem}' uses compatibility, retirement, or batch-scaffolding naming; name the module after the domain concept it owns."
            ),
        ));
    }
    let mut visitor = SmellVisitor {
        rel_path,
        check_names: !is_rule_self,
        cfg_gated_idents: Vec::new(),
        names: NameLedger::new(crate_names),
        diagnostics,
    };
    visitor.visit_file(ast);
    for (span, message) in visitor.names.take_compat_reports() {
        visitor.push(span, "rust/no-compat-names", message);
    }
    check_corpus_smells(rel_path, ast, diagnostics);
    check_async_effects(rel_path, ast, diagnostics);
}

struct SmellVisitor<'a> {
    rel_path: &'a str,
    check_names: bool,
    cfg_gated_idents: Vec<FxHashSet<String>>,
    names: NameLedger<'a>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl SmellVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message,
        ));
    }

    fn check_ident_name(&mut self, name: &str, span: Span) {
        if !self.check_names || self.names.note_compat(name, span) {
            return;
        }
        if let Some(message) = banned_lifecycle_message(name) {
            self.push(span, "rust/no-compat-names", message);
        }
    }

    fn check_wild_local(&mut self, span: Span, expr: &Expr) {
        let justified = binding_root_idents(expr).is_some_and(|roots| {
            roots.iter().all(|root| {
                self.cfg_gated_idents
                    .iter()
                    .any(|idents| idents.contains(root))
            })
        });
        if !justified && is_suppressed_binding_expr(expr) {
            self.push(
                span,
                "rust/no-let-underscore-suppression",
                "Do not suppress unused parameter, self, or field warnings with 'let _ = ...;'; remove the unused binding or use it.".to_owned(),
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
        visit::visit_item_fn(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        let struct_name = node.ident.to_string();
        self.check_ident_name(&struct_name, node.ident.span());
        for field in &node.fields {
            let Some(ident) = &field.ident else {
                continue;
            };
            let field_name = ident.to_string();
            self.check_ident_name(&field_name, ident.span());
            if field_name.starts_with('_') && !is_raii_or_marker_field(&field_name, &field.ty) {
                self.push(
                    ident.span(),
                    "rust/no-let-underscore-suppression",
                    format!(
                        "Struct '{}' field '{field_name}' uses a leading underscore to suppress dead-code or serde field checks; use the field or remove it.",
                        node.ident
                    ),
                );
            }
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_block(&mut self, node: &'ast Block) {
        let mut gated = FxHashSet::default();
        for statement in node
            .stmts
            .iter()
            .filter(|stmt| stmt_has_cfg_attribute(stmt))
        {
            collect_cfg_used_bindings(statement, &mut gated);
        }
        self.cfg_gated_idents.push(gated);
        visit::visit_block(self, node);
        self.cfg_gated_idents.pop();
    }

    fn visit_stmt(&mut self, node: &'ast Stmt) {
        if let Stmt::Local(local) = node
            && is_wild_pat(&local.pat)
            && !local.attrs.iter().any(is_cfg_attribute)
            && let Some(init) = &local.init
        {
            self.check_wild_local(local.let_token.span, &init.expr);
        }
        visit::visit_stmt(self, node);
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
            && stringifies_closure_error_param(closure)
        {
            self.push(
                node.method.span(),
                "rust/no-anemic-errors",
                "'.map_err(...)' converts the source error to a bare string without adding boundary context; wrap in a typed error or include the operation/input that failed.".to_owned(),
            );
        }
        if node.method == "as_str" && ident_to_string_call_span(&node.receiver).is_some() {
            self.push(
                node.method.span(),
                "rust/no-ident-to-string-compare",
                "Do not allocate '.to_string().as_str()' on 'syn::Ident'; compare 'ident == \"...\"' directly.".to_owned(),
            );
        }
        if node.method == "parse" && node.args.is_empty() && is_to_string_call(&node.receiver) {
            self.push(
                node.method.span(),
                "rust/no-value-roundtrip",
                "Do not round-trip a value through '.to_string().parse()'; convert or pass the typed value directly.".to_owned(),
            );
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_binary(&mut self, node: &'ast ExprBinary) {
        if matches!(node.op, BinOp::Eq(_) | BinOp::Ne(_)) {
            let span = if matches!(
                &*node.right,
                Expr::Lit(ExprLit {
                    lit: Lit::Str(_),
                    ..
                })
            ) {
                ident_to_string_call_span(&node.left)
            } else if matches!(
                &*node.left,
                Expr::Lit(ExprLit {
                    lit: Lit::Str(_),
                    ..
                })
            ) {
                ident_to_string_call_span(&node.right)
            } else {
                None
            };
            if let Some(span) = span {
                self.push(
                    span,
                    "rust/no-ident-to-string-compare",
                    "Do not allocate '.to_string()' on 'syn::Ident' to compare against a string literal; compare 'ident == \"...\"' directly.".to_owned(),
                );
            }
        }
        visit::visit_expr_binary(self, node);
    }

    fn visit_arm(&mut self, node: &'ast Arm) {
        if node.guard.is_none() && is_err_wild_pat(&node.pat) {
            match discarded_error_outcome(&node.body) {
                Some(DiscardedErrorOutcome::NewError) => self.push(
                    node.pat.span(),
                    "rust/no-silent-result-discard",
                    "'Err(_) => ...' raises a new error without its cause; bind the error and carry it as the source.".to_owned(),
                ),
                Some(DiscardedErrorOutcome::EmptyValue) => self.push(
                    node.pat.span(),
                    "rust/no-silent-result-discard",
                    "'Err(_) => ...' turns a failure into an empty value that looks valid; bind the error and propagate or report it explicitly.".to_owned(),
                ),
                None => {}
            }
        }
        visit::visit_arm(self, node);
    }

    fn visit_expr_let(&mut self, node: &'ast ExprLet) {
        if is_ok_tuple_pat(&node.pat) && is_fs_io_call(&node.expr) {
            self.push(
                node.pat.span(),
                "rust/no-silent-result-discard",
                "'if let Ok(...) = fs::...' silently ignores filesystem I/O failures; propagate or handle the I/O error explicitly.".to_owned(),
            );
        }
        visit::visit_expr_let(self, node);
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

fn binding_root_idents(expr: &Expr) -> Option<Vec<String>> {
    match expr {
        Expr::Tuple(tuple) => tuple.elems.iter().map(binding_root_idents).try_fold(
            Vec::new(),
            |mut roots, element| {
                roots.extend(element?);
                Some(roots)
            },
        ),
        other => binding_root_ident(other).map(|root| vec![root]),
    }
}

fn binding_root_ident(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Reference(reference) => binding_root_ident(&reference.expr),
        Expr::Paren(paren) => binding_root_ident(&paren.expr),
        Expr::Field(field) => binding_root_ident(&field.base),
        Expr::Path(path) => path.path.get_ident().map(ToString::to_string),
        _ => None,
    }
}

fn is_suppressed_binding_expr(expr: &Expr) -> bool {
    match expr {
        Expr::Reference(reference) => is_suppressed_binding_expr(&reference.expr),
        Expr::Paren(paren) => is_suppressed_binding_expr(&paren.expr),
        Expr::Path(_) | Expr::Field(_) | Expr::Tuple(_) => true,
        _ => false,
    }
}

fn ident_to_string_call_span(expr: &Expr) -> Option<Span> {
    let Expr::MethodCall(call) = expr else {
        return None;
    };
    if call.method != "to_string" || !call.args.is_empty() {
        return None;
    };
    let Expr::Field(ExprField {
        member: Member::Named(field_ident),
        ..
    }) = &*call.receiver
    else {
        return None;
    };
    (field_ident == "ident" || field_ident == "method").then(|| call.method.span())
}

fn is_to_string_call(expr: &Expr) -> bool {
    matches!(expr, Expr::MethodCall(call) if call.method == "to_string" && call.args.is_empty())
}

fn is_raii_or_marker_field(field_name: &str, ty: &syn::Type) -> bool {
    struct RaiiTypeFinder(bool);
    impl<'ast> Visit<'ast> for RaiiTypeFinder {
        fn visit_path_segment(&mut self, node: &'ast syn::PathSegment) {
            let name = node.ident.to_string();
            self.0 |= matches!(
                name.as_str(),
                "PhantomData"
                    | "Retention"
                    | "TempDir"
                    | "NamedTempFile"
                    | "countme"
                    | "Paren"
                    | "Bracket"
                    | "Brace"
            ) || name.ends_with("Guard")
                || name.ends_with("Permit")
                || name.ends_with("Lease");
            visit::visit_path_segment(self, node);
        }
    }
    if matches!(
        field_name,
        "_guard" | "_lock" | "_permit" | "_marker" | "_phantom" | "_thread_bound" | "_drop"
    ) || matches!(ty, syn::Type::Macro(_))
        || matches!(ty, syn::Type::Tuple(tuple) if tuple.elems.is_empty())
    {
        return true;
    }
    let mut finder = RaiiTypeFinder(false);
    finder.visit_type(ty);
    finder.0
}
