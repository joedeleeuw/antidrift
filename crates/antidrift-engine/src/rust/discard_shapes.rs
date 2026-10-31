use super::syn_kernel::path_ends_with;
use super::value_origin::peel_expr;
use syn::{Attribute, Expr, Stmt};

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
                    && let syn::Pat::Ident(pat) = &local.pat
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
            let (_, init) = bindings.iter().rev().find(|(ident, _)| *ident == name)?;
            return block_outcome(init, bindings);
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
