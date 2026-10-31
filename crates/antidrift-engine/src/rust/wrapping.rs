use super::RustDiagnostic;
use super::syn_kernel::{extract_pat_ident, is_wild_pat};
use super::workspace::relative_display;
use rustc_hash::{FxHashMap, FxHashSet};
use std::path::{Path, PathBuf};
use syn::visit::{self, Visit};
use syn::{Expr, ExprCall, FnArg, ItemFn, Stmt, Visibility};

const INERT_ATTRIBUTES: &[&str] = &[
    "inline",
    "must_use",
    "doc",
    "allow",
    "warn",
    "deny",
    "expect",
    "forbid",
    "cold",
    "track_caller",
    "deprecated",
    "rustfmt",
];

struct WrapperCandidate {
    file: PathBuf,
    line: usize,
    name: String,
    callee: String,
    public: bool,
}

#[derive(Default)]
struct ReferenceAudit {
    calls: FxHashMap<String, usize>,
    value_references: FxHashSet<String>,
}

pub(super) fn check_wrapping_functions(
    workspace_root: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut candidates = Vec::new();
    let mut audit = ReferenceAudit::default();
    for file in rs_files {
        let Some(ast) = parsed_files.get(file) else {
            continue;
        };
        let mut collector = CandidateCollector {
            file,
            candidates: &mut candidates,
        };
        collector.visit_file(ast);
        audit.visit_file(ast);
    }
    for candidate in candidates {
        if audit.value_references.contains(&candidate.name) {
            continue;
        }
        let calls = audit.calls.get(&candidate.name).copied().unwrap_or(0);
        if calls == 0 && candidate.public {
            continue;
        }
        let message = if calls == 0 {
            format!(
                "'{}' is a hop to '{}' with no call site in its crate; deleting it compiles. Delete '{}'.",
                candidate.name, candidate.callee, candidate.name
            )
        } else {
            format!(
                "'{}' is a hop to '{}': inlining it at its {calls} call site(s) keeps each call's bindings and evaluation order. Call '{}' directly and delete '{}'.",
                candidate.name, candidate.callee, candidate.callee, candidate.name
            )
        };
        diagnostics.push(RustDiagnostic::error(
            relative_display(workspace_root, &candidate.file),
            candidate.line,
            "rust/no-wrapping-functions",
            message,
        ));
    }
}

struct CandidateCollector<'a> {
    file: &'a Path,
    candidates: &'a mut Vec<WrapperCandidate>,
}

impl<'ast> Visit<'ast> for CandidateCollector<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        if node.sig.ident != "main"
            && node.sig.abi.is_none()
            && node.attrs.iter().all(|attr| {
                attr.path()
                    .get_ident()
                    .is_some_and(|ident| INERT_ATTRIBUTES.iter().any(|name| ident == name))
            })
            && let Some(callee) = detect_passthrough_wrapper(node)
        {
            self.candidates.push(WrapperCandidate {
                file: self.file.to_path_buf(),
                line: node.sig.ident.span().start().line.max(1),
                name: node.sig.ident.to_string(),
                callee,
                public: matches!(node.vis, Visibility::Public(_)),
            });
        }
        visit::visit_item_fn(self, node);
    }
}

impl<'ast> Visit<'ast> for ReferenceAudit {
    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Expr::Path(callee) = &*node.func {
            if let Some(last) = callee.path.segments.last() {
                *self.calls.entry(last.ident.to_string()).or_default() += 1;
            }
            for argument in &node.args {
                self.visit_expr(argument);
            }
            return;
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        if let Some(last) = node.path.segments.last() {
            self.value_references.insert(last.ident.to_string());
        }
        visit::visit_expr_path(self, node);
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        for token in node.tokens.clone() {
            collect_macro_idents(token, &mut self.value_references);
        }
        visit::visit_macro(self, node);
    }
}

fn collect_macro_idents(token: proc_macro2::TokenTree, out: &mut FxHashSet<String>) {
    match token {
        proc_macro2::TokenTree::Ident(ident) => {
            out.insert(ident.to_string());
        }
        proc_macro2::TokenTree::Group(group) => {
            for inner in group.stream() {
                collect_macro_idents(inner, out);
            }
        }
        _ => {}
    }
}

fn is_serde_adapter_param(ty: &syn::Type) -> bool {
    match ty {
        syn::Type::Path(tp) => tp.path.segments.last().is_some_and(|seg| {
            matches!(
                seg.ident.to_string().as_str(),
                "Serializer" | "Deserializer" | "D" | "S"
            )
        }),
        syn::Type::Reference(tr) => is_serde_adapter_param(&tr.elem),
        _ => false,
    }
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
        if !item_fn.sig.generics.params.is_empty() && is_serde_adapter_param(&pat_type.ty) {
            return None;
        }
        param_names.push(extract_pat_ident(&pat_type.pat)?.0);
    }
    let meaningful: Vec<&Stmt> = item_fn
        .block
        .stmts
        .iter()
        .filter(|s| !matches!(s, Stmt::Local(l) if is_wild_pat(&l.pat)))
        .collect();
    if meaningful.len() != 1 {
        return None;
    }
    let expr = match meaningful[0] {
        Stmt::Expr(expr, None) => expr,
        Stmt::Expr(Expr::Return(ret), _) => ret.expr.as_deref()?,
        _ => return None,
    };
    let Expr::Call(ExprCall { func, args, .. }) = expr else {
        return None;
    };
    let Expr::Path(callee_path) = &**func else {
        return None;
    };
    if args.len() != param_names.len()
        || !args
            .iter()
            .zip(&param_names)
            .all(|(arg, exp)| matches!(arg, Expr::Path(p) if p.path.is_ident(exp)))
    {
        return None;
    }
    let segments: Vec<String> = callee_path
        .path
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect();
    (!segments
        .last()
        .is_some_and(|l| l.as_bytes().first().is_some_and(u8::is_ascii_uppercase)))
    .then(|| segments.join("::"))
}
