use super::RustDiagnostic;
use super::struct_index::{ImportTable, PathResolution, file_scope};
use super::syn_ast::{extract_pat_ident, is_wild_pat};
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
    key: Vec<String>,
    name: String,
    callee: String,
    public: bool,
}

#[derive(Default)]
struct ReferenceAudit {
    imports: ImportTable,
    scope: Vec<String>,
    calls: FxHashMap<Vec<String>, usize>,
    value_references: FxHashSet<Vec<String>>,
    loose_calls: FxHashMap<String, usize>,
    loose_value_references: FxHashSet<String>,
}

enum ReferenceTarget {
    Resolved(Vec<String>),
    Loose(String),
}

impl ReferenceAudit {
    fn collect_imports(&mut self, scope: &[String], items: &[syn::Item]) {
        for item in items {
            match item {
                syn::Item::Use(import) => self.imports.collect(scope, &import.tree, &[]),
                syn::Item::Mod(syn::ItemMod {
                    ident,
                    content: Some((_, nested)),
                    ..
                }) => {
                    let mut child = scope.to_vec();
                    child.push(ident.to_string());
                    self.collect_imports(&child, nested);
                }
                _ => {}
            }
        }
    }

    fn record_reference(&mut self, path: &syn::Path, is_call: bool) {
        let segments: Vec<String> = path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect();
        let Some(name) = segments.last().cloned() else {
            return;
        };
        let bare_in_glob_scope = segments.len() == 1 && self.imports.scope_has_glob(&self.scope);
        let target = match self.imports.resolution(&self.scope, &segments) {
            PathResolution::Lexical(_) if bare_in_glob_scope => ReferenceTarget::Loose(name),
            PathResolution::Imported(path) | PathResolution::Lexical(path) => {
                let owner = &path[..path.len().saturating_sub(1)];
                if self.imports.scope_has_glob(owner) {
                    ReferenceTarget::Loose(name)
                } else {
                    ReferenceTarget::Resolved(path)
                }
            }
        };
        match (target, is_call) {
            (ReferenceTarget::Resolved(path), true) => {
                *self.calls.entry(path).or_default() += 1;
            }
            (ReferenceTarget::Resolved(path), false) => {
                self.value_references.insert(path);
            }
            (ReferenceTarget::Loose(bare), true) => {
                *self.loose_calls.entry(bare).or_default() += 1;
            }
            (ReferenceTarget::Loose(bare), false) => {
                self.loose_value_references.insert(bare);
            }
        }
    }

    fn calls_to(&self, candidate: &WrapperCandidate) -> usize {
        self.calls.get(&candidate.key).copied().unwrap_or(0)
            + self.loose_calls.get(&candidate.name).copied().unwrap_or(0)
    }

    fn references_value(&self, candidate: &WrapperCandidate) -> bool {
        self.value_references.contains(&candidate.key)
            || self.loose_value_references.contains(&candidate.name)
    }
}

pub(super) fn check_wrapping_functions(
    workspace_root: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut candidates = Vec::new();
    let mut audit = ReferenceAudit::default();
    let parsed = rs_files
        .iter()
        .filter_map(|file| parsed_files.get(file).map(|ast| (file, ast)))
        .collect::<Vec<_>>();
    for (file, ast) in &parsed {
        let scope = file_scope(file);
        let mut collector = CandidateCollector {
            file,
            scope: scope.clone(),
            candidates: &mut candidates,
        };
        collector.visit_file(ast);
        audit.collect_imports(&scope, &ast.items);
    }
    for (file, ast) in &parsed {
        audit.scope = file_scope(file);
        audit.visit_file(ast);
    }
    for candidate in candidates {
        if audit.references_value(&candidate) {
            continue;
        }
        let calls = audit.calls_to(&candidate);
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
    scope: Vec<String>,
    candidates: &'a mut Vec<WrapperCandidate>,
}

impl<'ast> Visit<'ast> for CandidateCollector<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.scope.push(node.ident.to_string());
        visit::visit_item_mod(self, node);
        self.scope.pop();
    }

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
            let mut key = self.scope.clone();
            key.push(node.sig.ident.to_string());
            self.candidates.push(WrapperCandidate {
                file: self.file.to_path_buf(),
                line: node.sig.ident.span().start().line.max(1),
                key,
                name: node.sig.ident.to_string(),
                callee,
                public: matches!(node.vis, Visibility::Public(_)),
            });
        }
        visit::visit_item_fn(self, node);
    }
}

impl<'ast> Visit<'ast> for ReferenceAudit {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.scope.push(node.ident.to_string());
        visit::visit_item_mod(self, node);
        self.scope.pop();
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Expr::Path(callee) = &*node.func {
            self.record_reference(&callee.path, true);
            for argument in &node.args {
                self.visit_expr(argument);
            }
            return;
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        self.record_reference(&node.path, false);
        visit::visit_expr_path(self, node);
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        for token in node.tokens.clone() {
            collect_macro_idents(token, &mut self.loose_value_references);
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
