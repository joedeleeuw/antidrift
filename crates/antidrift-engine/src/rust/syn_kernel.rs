use proc_macro2::Span;
use syn::visit::{self, Visit};
use syn::{Attribute, BinOp, Expr, ExprCall, ExprPath, Meta, Pat};

pub(super) fn path_ends_with(path: &syn::Path, expected: &[&str]) -> bool {
    if path.segments.len() < expected.len() {
        return false;
    }
    path.segments
        .iter()
        .rev()
        .zip(expected.iter().rev())
        .all(|(seg, want)| seg.ident == *want)
}

pub(super) fn is_banned_test_attribute(attr: &Attribute) -> bool {
    let path = attr.path();
    if path
        .segments
        .last()
        .is_some_and(|seg| seg.ident == "test" || seg.ident == "rstest")
    {
        return true;
    }
    let Meta::List(list) = &attr.meta else {
        return false;
    };
    path.segments
        .last()
        .is_some_and(|seg| seg.ident == "cfg" || seg.ident == "cfg_attr")
        && token_stream_contains_test(list.tokens.clone())
}

fn token_stream_contains_test(tokens: proc_macro2::TokenStream) -> bool {
    let mut neg = false;
    tokens.into_iter().any(|tree| match tree {
        proc_macro2::TokenTree::Ident(id) => {
            let hit = id == "test" && !neg;
            neg = id == "not";
            hit
        }
        proc_macro2::TokenTree::Group(g) => {
            let hit = !neg && token_stream_contains_test(g.stream());
            neg = false;
            hit
        }
        _ => {
            neg = false;
            false
        }
    })
}

pub(super) fn derives_deserialize(attrs: &[Attribute]) -> bool {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("derive"))
        .any(|attr| {
            let mut found = false;
            attr.parse_nested_meta(|meta| {
                found |= meta.path.is_ident("Deserialize")
                    || path_ends_with(&meta.path, &["serde", "Deserialize"]);
                Ok(())
            })
            .is_ok()
                && found
        })
}

pub(super) fn has_serde_deny_unknown_fields(attrs: &[Attribute]) -> bool {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("serde"))
        .any(|attr| {
            let mut found = false;
            attr.parse_nested_meta(|meta| {
                found |= meta.path.is_ident("deny_unknown_fields");
                if meta.input.peek(syn::token::Eq) {
                    meta.input.parse::<syn::Token![=]>()?;
                    meta.input.parse::<Expr>()?;
                }
                Ok(())
            })
            .is_ok()
                && found
        })
}

pub(super) fn is_ok_tuple_pat(pat: &Pat) -> bool {
    let Pat::TupleStruct(tuple) = pat else {
        return false;
    };
    tuple
        .path
        .segments
        .last()
        .is_some_and(|seg| seg.ident == "Ok")
}

pub(super) fn extract_pat_ident(pat: &Pat) -> Option<(String, Span)> {
    match pat {
        Pat::Ident(pat_ident) => Some((pat_ident.ident.to_string(), pat_ident.ident.span())),
        Pat::Type(pat_type) => extract_pat_ident(&pat_type.pat),
        Pat::Reference(reference) => extract_pat_ident(&reference.pat),
        _ => None,
    }
}

pub(super) fn is_wild_pat(pat: &Pat) -> bool {
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

pub(super) fn expr_mentions_ident(expr: &Expr, target: &str) -> bool {
    let mut visitor = IdentMentionVisitor {
        target,
        found: false,
    };
    visitor.visit_expr(expr);
    visitor.found
}

pub(super) fn call_path_ends_with(call: &ExprCall, expected: &[&str]) -> bool {
    matches!(&*call.func, Expr::Path(callee) if path_ends_with(&callee.path, expected))
}

pub(super) fn is_compound_assign_op(op: &BinOp) -> bool {
    matches!(
        op,
        BinOp::AddAssign(_)
            | BinOp::SubAssign(_)
            | BinOp::MulAssign(_)
            | BinOp::DivAssign(_)
            | BinOp::RemAssign(_)
            | BinOp::BitXorAssign(_)
            | BinOp::BitAndAssign(_)
            | BinOp::BitOrAssign(_)
            | BinOp::ShlAssign(_)
            | BinOp::ShrAssign(_)
    )
}

pub(super) fn has_derive_or_repr(attrs: &[Attribute], traits: &[&str]) -> bool {
    for attr in attrs {
        if attr.path().is_ident("repr") {
            return true;
        }
        if !attr.path().is_ident("derive") {
            continue;
        }
        let mut excluded = false;
        let parsed = attr.parse_nested_meta(|meta| {
            if meta
                .path
                .segments
                .last()
                .is_some_and(|seg| traits.iter().any(|name| seg.ident == *name))
            {
                excluded = true;
            }
            Ok(())
        });
        if parsed.is_ok() && excluded {
            return true;
        }
    }
    false
}

pub(super) fn is_err_wild_pat(pat: &Pat) -> bool {
    let Pat::TupleStruct(tuple) = pat else {
        return false;
    };
    tuple
        .path
        .segments
        .last()
        .is_some_and(|seg| seg.ident == "Err")
        && tuple.elems.len() == 1
        && is_wild_pat(&tuple.elems[0])
}

pub(super) fn is_fs_io_call(expr: &Expr) -> bool {
    let Expr::Call(ExprCall { func, .. }) = expr else {
        return false;
    };
    let Expr::Path(callee) = &**func else {
        return false;
    };
    let segments: Vec<&syn::Ident> = callee.path.segments.iter().map(|s| &s.ident).collect();
    let Some(last) = segments.last() else {
        return false;
    };
    segments.len() >= 2
        && *segments[segments.len() - 2] == "fs"
        && (**last == "read_to_string"
            || **last == "read"
            || **last == "write"
            || **last == "read_dir"
            || **last == "metadata")
}
