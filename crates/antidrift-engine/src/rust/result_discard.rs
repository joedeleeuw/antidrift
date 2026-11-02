use super::RustDiagnostic;
use super::syn_ast::{call_path_ends_with, extract_pat_ident, is_ok_tuple_pat, path_ends_with};
use super::value_origin::peel_expr;
use antidrift_kernel::runtime_lifecycle::spans_multiple_artifact_tiers;
use proc_macro2::Span;
use rustc_hash::FxHashMap;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Arm, Expr, ExprLet, ExprLit, ExprMethodCall, ImplItemFn, ItemFn, Lit, Local, Pat, Stmt};

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

enum DiscardedErrorOutcome {
    NewError,
    EmptyValue,
}

pub(super) fn check_result_discards(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    ResultDiscardVisitor {
        rel_path,
        fn_has_mtime_check: false,
        local_string_lists: FxHashMap::default(),
        diagnostics,
    }
    .visit_file(ast);
}

struct ResultDiscardVisitor<'a> {
    rel_path: &'a str,
    fn_has_mtime_check: bool,
    local_string_lists: FxHashMap<String, Vec<String>>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl ResultDiscardVisitor<'_> {
    fn push(&mut self, span: Span, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            "rust/no-silent-result-discard",
            message.into(),
        ));
    }

    fn visit_fn_scope(&mut self, has_mtime: bool, body: impl FnOnce(&mut Self)) {
        let prev = (
            self.fn_has_mtime_check,
            std::mem::take(&mut self.local_string_lists),
        );
        self.fn_has_mtime_check = has_mtime;
        body(self);
        (self.fn_has_mtime_check, self.local_string_lists) = prev;
    }
}

impl<'ast> Visit<'ast> for ResultDiscardVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        let has_mtime = block_mentions_modified(&node.block);
        self.visit_fn_scope(has_mtime, |this| visit::visit_item_fn(this, node));
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        let has_mtime = block_mentions_modified(&node.block);
        self.visit_fn_scope(has_mtime, |this| visit::visit_impl_item_fn(this, node));
    }

    fn visit_arm(&mut self, node: &'ast Arm) {
        if node.guard.is_none() && is_err_wild_pat(&node.pat) {
            match discarded_error_outcome(&node.body) {
                Some(DiscardedErrorOutcome::NewError) => self.push(
                    node.pat.span(),
                    "'Err(_) => ...' raises a new error without its cause; bind the error and carry it as the source.",
                ),
                Some(DiscardedErrorOutcome::EmptyValue) => self.push(
                    node.pat.span(),
                    "'Err(_) => ...' turns a failure into an empty value that looks valid; bind the error and propagate or report it explicitly.",
                ),
                None => {}
            }
        }
        visit::visit_arm(self, node);
    }

    fn visit_local(&mut self, node: &'ast Local) {
        if let Some(local_ident) = extract_pat_ident(&node.pat).map(|(name, _)| name)
            && let Some(init) = &node.init
        {
            let mut lits = Vec::new();
            collect_string_literals(&init.expr, &mut lits);
            if lits.len() >= 2 {
                self.local_string_lists.insert(local_ident, lits);
            }
        }
        visit::visit_local(self, node);
    }

    fn visit_expr_let(&mut self, node: &'ast ExprLet) {
        if is_ok_tuple_pat(&node.pat) && is_fs_io_call(&node.expr) {
            self.push(
                node.pat.span(),
                "'if let Ok(...) = fs::...' silently ignores filesystem I/O failures; propagate or handle the I/O error explicitly.",
            );
        }
        visit::visit_expr_let(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if is_fs_read_to_string_sentinel(node) {
            self.push(
                node.method.span(),
                "fs::read_to_string failure is collapsed into \"\" via fallback, erasing the distinction between missing file and empty file; propagate the io::Error or return Option<String>.",
            );
        }
        if node.method == "find"
            && !self.fn_has_mtime_check
            && is_multi_tier_exists_find(node, &self.local_string_lists)
        {
            self.push(
                node.method.span(),
                "First-match '.find(|p| p.exists())' spans multiple build output tiers (debug/release/dist) without comparing modification times; sort candidates by metadata().modified() so stale build tiers do not shadow newer builds.",
            );
        }
        visit::visit_expr_method_call(self, node);
    }
}

fn discarded_error_outcome(body: &Expr) -> Option<DiscardedErrorOutcome> {
    let mut bindings: Vec<(&syn::Ident, &Expr)> = Vec::new();
    block_outcome(body, &mut bindings)
}

fn block_outcome<'a>(
    body: &'a Expr,
    bindings: &mut Vec<(&'a syn::Ident, &'a Expr)>,
) -> Option<DiscardedErrorOutcome> {
    match body {
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
            match last {
                Stmt::Expr(Expr::Return(ret), _) => block_outcome(ret.expr.as_deref()?, bindings),
                Stmt::Expr(tail, None) => block_outcome(tail, bindings),
                _ => None,
            }
        }
        Expr::Return(ret) => classify_outcome_expr(ret.expr.as_deref()?),
        Expr::Path(path) => {
            let name = path.path.get_ident()?;
            let index = bindings.iter().rposition(|(ident, _)| *ident == name)?;
            let (_, init) = bindings[index];
            let mut earlier = bindings[..index].to_vec();
            block_outcome(init, &mut earlier)
        }
        other => classify_outcome_expr(other),
    }
}

fn classify_outcome_expr(outcome: &Expr) -> Option<DiscardedErrorOutcome> {
    match peel_expr(outcome) {
        Expr::Call(call) => {
            let Expr::Path(callee) = &*call.func else {
                return None;
            };
            if path_ends_with(&callee.path, &["Err"]) {
                return Some(DiscardedErrorOutcome::NewError);
            }
            (call.args.is_empty()
                && path_ends_with_any(&callee.path, &["new", "default"])
                && callee.path.segments.len() >= 2
                && EMPTY_CONSTRUCTOR_OWNERS
                    .iter()
                    .any(|owner| callee.path.segments.iter().any(|seg| seg.ident == *owner)))
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

fn path_ends_with_any(path: &syn::Path, names: &[&str]) -> bool {
    path.segments
        .last()
        .is_some_and(|seg| names.iter().any(|name| seg.ident == *name))
}

fn is_err_wild_pat(pat: &Pat) -> bool {
    let Pat::TupleStruct(tuple) = pat else {
        return false;
    };
    if !tuple
        .path
        .segments
        .last()
        .is_some_and(|seg| seg.ident == "Err")
    {
        return false;
    }
    tuple.elems.len() == 1 && matches!(tuple.elems.first(), Some(Pat::Wild(_)))
}

fn is_fs_io_call(expr: &Expr) -> bool {
    const FS_IO_CALLS: &[&str] = &[
        "read_to_string",
        "read",
        "read_dir",
        "write",
        "create_dir_all",
        "remove_file",
    ];
    let Expr::Call(call) = expr else {
        return false;
    };
    let Expr::Path(callee) = &*call.func else {
        return false;
    };
    let segs: Vec<&syn::Ident> = callee.path.segments.iter().map(|s| &s.ident).collect();
    segs.len() >= 2
        && *segs[segs.len() - 2] == "fs"
        && FS_IO_CALLS.iter().any(|op| *segs[segs.len() - 1] == *op)
}

fn is_multi_tier_exists_find(
    node: &ExprMethodCall,
    local_lists: &FxHashMap<String, Vec<String>>,
) -> bool {
    let Some(Expr::Closure(closure)) = node.args.first() else {
        return false;
    };
    if !expr_calls_path_exists(&closure.body) {
        return false;
    }
    let mut candidates = Vec::new();
    collect_receiver_candidates(&node.receiver, local_lists, &mut candidates);
    spans_multiple_artifact_tiers(candidates.iter().map(String::as_str))
}

fn expr_calls_path_exists(expr: &Expr) -> bool {
    match expr {
        Expr::MethodCall(call) => {
            call.method == "exists"
                || call.method == "is_file"
                || expr_calls_path_exists(&call.receiver)
                || call.args.iter().any(expr_calls_path_exists)
        }
        Expr::Block(b) => b.block.stmts.iter().any(|s| match s {
            Stmt::Expr(e, _) => expr_calls_path_exists(e),
            _ => false,
        }),
        _ => false,
    }
}

fn collect_receiver_candidates(
    expr: &Expr,
    local_lists: &FxHashMap<String, Vec<String>>,
    out: &mut Vec<String>,
) {
    match expr {
        Expr::MethodCall(call) => collect_receiver_candidates(&call.receiver, local_lists, out),
        Expr::Path(ep) => {
            if let Some(ident) = ep.path.get_ident()
                && let Some(list) = local_lists.get(&ident.to_string())
            {
                out.extend(list.iter().cloned());
            }
        }
        other => collect_string_literals(other, out),
    }
}

fn collect_string_literals(expr: &Expr, out: &mut Vec<String>) {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) => out.push(s.value()),
        Expr::Array(arr) => {
            for elem in &arr.elems {
                collect_string_literals(elem, out);
            }
        }
        Expr::Reference(r) => collect_string_literals(&r.expr, out),
        Expr::MethodCall(mc) => {
            collect_string_literals(&mc.receiver, out);
            for arg in &mc.args {
                collect_string_literals(arg, out);
            }
        }
        Expr::Call(call) => {
            for arg in &call.args {
                collect_string_literals(arg, out);
            }
        }
        _ => {}
    }
}

fn block_mentions_modified(block: &syn::Block) -> bool {
    struct ModifiedFinder(bool);
    impl<'ast> Visit<'ast> for ModifiedFinder {
        fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
            if node.method == "modified" || node.method == "metadata" {
                self.0 = true;
            }
            visit::visit_expr_method_call(self, node);
        }
    }
    let mut finder = ModifiedFinder(false);
    finder.visit_block(block);
    finder.0
}

fn is_fs_read_to_string_call(expr: &Expr) -> bool {
    matches!(expr, Expr::Call(call) if call_path_ends_with(call, &["fs", "read_to_string"]))
}

fn is_empty_string_expr(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) => s.value().is_empty(),
        Expr::Call(call) => call.args.is_empty() && call_path_ends_with(call, &["String", "new"]),
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
