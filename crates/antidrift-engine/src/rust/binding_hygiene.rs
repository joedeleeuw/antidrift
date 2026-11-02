use super::RustDiagnostic;
use super::lifecycle_names::{CrateNames, NameLedger};
use super::syn_ast::{extract_pat_ident, is_untyped_wild_pat, is_wild_pat};
use antidrift_kernel::declared_names::is_compat_name;
use proc_macro2::Span;
use rustc_hash::FxHashSet;
use std::path::Path;
use syn::ext::IdentExt;
use syn::visit::{self, Visit};
use syn::{Attribute, Block, Expr, FnArg, ItemEnum, ItemFn, ItemStruct, ItemType, Pat, Stmt};

pub(super) fn check_binding_hygiene(
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
        && is_compat_name(stem)
    {
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            1,
            "rust/no-compat-names",
            format!(
                "Module '{stem}' uses compatibility naming; name the module after the domain concept it owns."
            ),
        ));
    }
    let mut visitor = BindingHygieneVisitor {
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
}

struct BindingHygieneVisitor<'a> {
    rel_path: &'a str,
    check_names: bool,
    cfg_gated_idents: Vec<FxHashSet<String>>,
    names: NameLedger<'a>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl BindingHygieneVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message,
        ));
    }

    fn check_ident_name(&mut self, name: &str, span: Span) {
        if self.check_names {
            self.names.note_compat(name, span);
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

impl<'ast> Visit<'ast> for BindingHygieneVisitor<'_> {
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
            && is_untyped_wild_pat(&local.pat)
            && !local.attrs.iter().any(is_cfg_attribute)
            && let Some(init) = &local.init
        {
            self.check_wild_local(local.let_token.span, &init.expr);
        }
        visit::visit_stmt(self, node);
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

fn is_cfg_attribute(attr: &Attribute) -> bool {
    attr.path().is_ident("cfg")
}

fn stmt_has_cfg_attribute(stmt: &Stmt) -> bool {
    let attrs: &[Attribute] = match stmt {
        Stmt::Local(local) => &local.attrs,
        Stmt::Macro(stmt_macro) => &stmt_macro.attrs,
        Stmt::Item(item) => item_attributes(item),
        Stmt::Expr(expr, _) => expr_attributes(expr),
    };
    attrs.iter().any(is_cfg_attribute)
}

fn item_attributes(item: &syn::Item) -> &[Attribute] {
    match item {
        syn::Item::Const(item) => &item.attrs,
        syn::Item::Fn(item) => &item.attrs,
        syn::Item::Macro(item) => &item.attrs,
        syn::Item::Mod(item) => &item.attrs,
        syn::Item::Static(item) => &item.attrs,
        syn::Item::Struct(item) => &item.attrs,
        syn::Item::Use(item) => &item.attrs,
        _ => &[],
    }
}

fn expr_attributes(expr: &Expr) -> &[Attribute] {
    match expr {
        Expr::Assign(expr) => &expr.attrs,
        Expr::Block(expr) => &expr.attrs,
        Expr::Call(expr) => &expr.attrs,
        Expr::ForLoop(expr) => &expr.attrs,
        Expr::If(expr) => &expr.attrs,
        Expr::Macro(expr) => &expr.attrs,
        Expr::Match(expr) => &expr.attrs,
        Expr::MethodCall(expr) => &expr.attrs,
        Expr::Return(expr) => &expr.attrs,
        Expr::Unsafe(expr) => &expr.attrs,
        Expr::While(expr) => &expr.attrs,
        _ => &[],
    }
}

fn collect_cfg_used_bindings(stmt: &Stmt, out: &mut FxHashSet<String>) {
    if matches!(stmt, Stmt::Local(local) if is_wild_pat(&local.pat)) {
        return;
    }
    let mut collector = CfgBindingCollector {
        out,
        shadowed: FxHashSet::default(),
    };
    collector.visit_stmt(stmt);
}

struct PatBindingCollector<'a>(&'a mut FxHashSet<String>);

impl<'ast> Visit<'ast> for PatBindingCollector<'_> {
    fn visit_pat_ident(&mut self, node: &'ast syn::PatIdent) {
        self.0.insert(node.ident.unraw().to_string());
        visit::visit_pat_ident(self, node);
    }
}

fn record_pat_bindings(pat: &Pat, shadowed: &mut FxHashSet<String>) {
    PatBindingCollector(shadowed).visit_pat(pat);
}

struct CfgBindingCollector<'a> {
    out: &'a mut FxHashSet<String>,
    shadowed: FxHashSet<String>,
}

impl CfgBindingCollector<'_> {
    fn record_ident(&mut self, ident: &syn::Ident) {
        let name = ident.unraw().to_string();
        if !self.shadowed.contains(&name) {
            self.out.insert(name);
        }
    }

    fn collect_macro_tokens(&mut self, tokens: proc_macro2::TokenStream) {
        let trees: Vec<proc_macro2::TokenTree> = tokens.into_iter().collect();
        for (index, tree) in trees.iter().enumerate() {
            match tree {
                proc_macro2::TokenTree::Ident(ident)
                    if is_standalone_macro_ident(&trees, index) =>
                {
                    self.record_ident(ident);
                }
                proc_macro2::TokenTree::Group(group) => {
                    self.collect_macro_tokens(group.stream());
                }
                _ => {}
            }
        }
    }

    fn visit_local_stmt(&mut self, local: &syn::Local) {
        if is_wild_pat(&local.pat) {
            return;
        }
        if let Some(init) = &local.init {
            self.visit_expr(&init.expr);
            if let Some((_, diverge)) = &init.diverge {
                self.visit_expr(diverge);
            }
        }
        record_pat_bindings(&local.pat, &mut self.shadowed);
    }
}

fn is_standalone_macro_ident(trees: &[proc_macro2::TokenTree], index: usize) -> bool {
    let preceded_by_access = index > 0
        && matches!(
            &trees[index - 1],
            proc_macro2::TokenTree::Punct(p) if p.as_char() == '.' || p.as_char() == ':'
        );
    let followed_by_label_or_macro = matches!(
        trees.get(index + 1),
        Some(proc_macro2::TokenTree::Punct(p)) if p.as_char() == ':' || p.as_char() == '!'
    );
    !preceded_by_access && !followed_by_label_or_macro
}

impl<'ast> Visit<'ast> for CfgBindingCollector<'_> {
    fn visit_item(&mut self, _node: &'ast syn::Item) {}

    fn visit_block(&mut self, node: &'ast Block) {
        let saved = self.shadowed.clone();
        for statement in &node.stmts {
            self.visit_stmt(statement);
        }
        self.shadowed = saved;
    }

    fn visit_stmt(&mut self, node: &'ast Stmt) {
        match node {
            Stmt::Local(local) => self.visit_local_stmt(local),
            Stmt::Macro(stmt_macro) => {
                self.collect_macro_tokens(stmt_macro.mac.tokens.clone());
            }
            Stmt::Expr(expr, _) => self.visit_expr(expr),
            Stmt::Item(_) => {}
        }
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        let saved = self.shadowed.clone();
        for input in &node.inputs {
            record_pat_bindings(input, &mut self.shadowed);
        }
        self.visit_expr(&node.body);
        self.shadowed = saved;
    }

    fn visit_arm(&mut self, node: &'ast syn::Arm) {
        let saved = self.shadowed.clone();
        record_pat_bindings(&node.pat, &mut self.shadowed);
        if let Some((_, guard)) = &node.guard {
            self.visit_expr(guard);
        }
        self.visit_expr(&node.body);
        self.shadowed = saved;
    }

    fn visit_expr_for_loop(&mut self, node: &'ast syn::ExprForLoop) {
        self.visit_expr(&node.expr);
        let saved = self.shadowed.clone();
        record_pat_bindings(&node.pat, &mut self.shadowed);
        self.visit_block(&node.body);
        self.shadowed = saved;
    }

    fn visit_expr_let(&mut self, node: &'ast syn::ExprLet) {
        self.visit_expr(&node.expr);
        record_pat_bindings(&node.pat, &mut self.shadowed);
    }

    fn visit_expr_if(&mut self, node: &'ast syn::ExprIf) {
        let saved = self.shadowed.clone();
        self.visit_expr(&node.cond);
        self.visit_block(&node.then_branch);
        self.shadowed = saved;
        if let Some((_, else_branch)) = &node.else_branch {
            self.visit_expr(else_branch);
        }
    }

    fn visit_expr_while(&mut self, node: &'ast syn::ExprWhile) {
        let saved = self.shadowed.clone();
        self.visit_expr(&node.cond);
        self.visit_block(&node.body);
        self.shadowed = saved;
    }

    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        if node.qself.is_none()
            && node.path.segments.len() == 1
            && let Some(segment) = node.path.segments.first()
        {
            self.record_ident(&segment.ident);
        }
        visit::visit_expr_path(self, node);
    }

    fn visit_expr_macro(&mut self, node: &'ast syn::ExprMacro) {
        self.collect_macro_tokens(node.mac.tokens.clone());
    }
}
