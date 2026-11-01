use super::syn_kernel::{is_wild_pat, path_ends_with};
use super::value_origin::peel_expr;
use rustc_hash::FxHashSet;
use syn::ext::IdentExt;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, Pat, Stmt};

pub(super) fn is_cfg_attribute(attr: &Attribute) -> bool {
    attr.path().is_ident("cfg")
}

pub(super) fn stmt_has_cfg_attribute(stmt: &Stmt) -> bool {
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

pub(super) enum DiscardedErrorOutcome {
    NewError,
    EmptyValue,
}

pub(super) fn discarded_error_outcome(body: &Expr) -> Option<DiscardedErrorOutcome> {
    let mut bindings: Vec<(&syn::Ident, &Expr)> = Vec::new();
    block_outcome(body, &mut bindings)
}

fn block_outcome<'a>(
    body: &'a Expr,
    bindings: &mut Vec<(&'a syn::Ident, &'a Expr)>,
) -> Option<DiscardedErrorOutcome> {
    let outcome = match body {
        Expr::Block(block) => {
            let (last, leading) = block.block.stmts.split_last()?;
            for statement in leading {
                if let Stmt::Local(local) = statement
                    && let Pat::Ident(pat) = &local.pat
                    && let Some(init) = &local.init
                {
                    bindings.push((&pat.ident, &init.expr));
                }
            }
            return match last {
                Stmt::Expr(Expr::Return(ret), _) => block_outcome(ret.expr.as_deref()?, bindings),
                Stmt::Expr(tail, None) => block_outcome(tail, bindings),
                _ => None,
            };
        }
        Expr::Return(ret) => ret.expr.as_deref()?,
        Expr::Path(path) => {
            let name = path.path.get_ident()?;
            let index = bindings.iter().rposition(|(ident, _)| *ident == name)?;
            let (_, init) = bindings[index];
            let mut earlier = bindings[..index].to_vec();
            return block_outcome(init, &mut earlier);
        }
        other => other,
    };
    match peel_expr(outcome) {
        Expr::Call(call) => {
            let Expr::Path(callee) = &*call.func else {
                return None;
            };
            if path_ends_with(&callee.path, &["Err"]) {
                return Some(DiscardedErrorOutcome::NewError);
            }
            (call.args.is_empty()
                && (path_ends_with_any(&callee.path, &["new", "default"])
                    && callee.path.segments.len() >= 2
                    && EMPTY_CONSTRUCTOR_OWNERS
                        .iter()
                        .any(|owner| callee.path.segments.iter().any(|seg| seg.ident == *owner))))
            .then_some(DiscardedErrorOutcome::EmptyValue)
        }
        Expr::Macro(expr_macro) => {
            let name = expr_macro.mac.path.segments.last()?.ident.to_string();
            match name.as_str() {
                "bail" | "anyhow" | "panic" | "format_err" => Some(DiscardedErrorOutcome::NewError),
                "vec" if expr_macro.mac.tokens.is_empty() => {
                    Some(DiscardedErrorOutcome::EmptyValue)
                }
                _ => None,
            }
        }
        _ => None,
    }
}

const EMPTY_CONSTRUCTOR_OWNERS: &[&str] = &[
    "Vec",
    "String",
    "HashMap",
    "HashSet",
    "BTreeMap",
    "BTreeSet",
    "FxHashMap",
    "FxHashSet",
    "VecDeque",
    "Default",
];

fn path_ends_with_any(path: &syn::Path, names: &[&str]) -> bool {
    path.segments
        .last()
        .is_some_and(|seg| names.iter().any(|name| seg.ident == *name))
}

pub(super) fn collect_cfg_used_bindings(stmt: &Stmt, out: &mut FxHashSet<String>) {
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

    fn visit_block(&mut self, node: &'ast syn::Block) {
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
