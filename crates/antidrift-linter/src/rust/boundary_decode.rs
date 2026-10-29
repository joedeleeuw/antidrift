use super::RustDiagnostic;
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Expr, ExprCall, ExprForLoop, ExprIf, ExprLet, ExprLoop, ExprMethodCall, ExprWhile, FnArg,
    ImplItemFn, ItemFn, Pat,
};

const LINE_CHUNK_IDENTIFIERS: &[&str] = &["line", "raw", "text", "chunk", "candidate", "trimmed"];
const SNIFFER_FN_PREFIXES: &[&str] = &["try_", "sniff_", "probe_", "extract_", "detect_", "maybe_"];

pub(super) fn check_decode_to_option(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let lower = rel_path.to_ascii_lowercase();
    if lower.contains("parser") || lower.contains("grammar") || lower.contains("tool_call") {
        return;
    }
    let mut visitor = DecodeToOptionVisitor {
        rel_path,
        in_loop_or_stream_closure: false,
        in_sniffer_fn: false,
        diagnostics,
    };
    visitor.visit_file(ast);
}

struct DecodeToOptionVisitor<'a> {
    rel_path: &'a str,
    in_loop_or_stream_closure: bool,
    in_sniffer_fn: bool,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl DecodeToOptionVisitor<'_> {
    fn push(&mut self, span: Span, callee: &str, suppression: &str) {
        self.diagnostics.push(RustDiagnostic {
            file: self.rel_path.to_owned(),
            line: span.start().line.max(1),
            rule_id: "rust/no-decode-to-option",
            message: format!(
                "Boundary decode '{callee}' is collapsed via '{suppression}', erasing schema/syntax failures into absence or a silent default; propagate or report the decode error explicitly."
            ),
        });
    }

    fn is_exempt(&self, decode_call: &ExprCall) -> bool {
        self.in_loop_or_stream_closure
            || self.in_sniffer_fn
            || decode_call
                .args
                .first()
                .is_some_and(arg_mentions_line_or_chunk)
    }
}

impl<'ast> Visit<'ast> for DecodeToOptionVisitor<'_> {
    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        let prev = self.in_sniffer_fn;
        self.in_sniffer_fn =
            prev || is_sniffer_signature(&node.sig.ident.to_string(), &node.sig.inputs);
        visit::visit_item_fn(self, node);
        self.in_sniffer_fn = prev;
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        let prev = self.in_sniffer_fn;
        self.in_sniffer_fn =
            prev || is_sniffer_signature(&node.sig.ident.to_string(), &node.sig.inputs);
        visit::visit_impl_item_fn(self, node);
        self.in_sniffer_fn = prev;
    }

    fn visit_expr_for_loop(&mut self, node: &'ast ExprForLoop) {
        let prev = self.in_loop_or_stream_closure;
        self.in_loop_or_stream_closure = true;
        visit::visit_expr_for_loop(self, node);
        self.in_loop_or_stream_closure = prev;
    }

    fn visit_expr_while(&mut self, node: &'ast ExprWhile) {
        let prev = self.in_loop_or_stream_closure;
        self.in_loop_or_stream_closure = true;
        visit::visit_expr_while(self, node);
        self.in_loop_or_stream_closure = prev;
    }

    fn visit_expr_loop(&mut self, node: &'ast ExprLoop) {
        let prev = self.in_loop_or_stream_closure;
        self.in_loop_or_stream_closure = true;
        visit::visit_expr_loop(self, node);
        self.in_loop_or_stream_closure = prev;
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let method_name = node.method.to_string();
        if matches!(
            method_name.as_str(),
            "filter_map" | "flat_map" | "map" | "find_map"
        ) && receiver_is_line_or_split_iter(&node.receiver)
        {
            let prev = self.in_loop_or_stream_closure;
            self.in_loop_or_stream_closure = true;
            visit::visit_expr_method_call(self, node);
            self.in_loop_or_stream_closure = prev;
            return;
        }
        if matches!(
            method_name.as_str(),
            "ok" | "unwrap_or" | "unwrap_or_default" | "unwrap_or_else"
        ) && let Some((decode_call, callee_label)) = extract_serde_decode_call(&node.receiver)
            && !self.is_exempt(decode_call)
        {
            self.push(
                node.method.span(),
                &callee_label,
                &format!(".{method_name}()"),
            );
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_if(&mut self, node: &'ast ExprIf) {
        if node.else_branch.is_none()
            && let Expr::Let(ExprLet { pat, expr, .. }) = &*node.cond
            && is_ok_tuple_pat(pat)
            && let Some((decode_call, callee_label)) = extract_serde_decode_call(expr)
            && !self.is_exempt(decode_call)
        {
            self.push(pat.span(), &callee_label, "if let Ok(...)");
        }
        visit::visit_expr_if(self, node);
    }
}

fn is_sniffer_signature(
    fn_name: &str,
    inputs: &syn::punctuated::Punctuated<FnArg, syn::Token![,]>,
) -> bool {
    SNIFFER_FN_PREFIXES
        .iter()
        .any(|prefix| fn_name.starts_with(prefix))
        || inputs.iter().any(|arg| {
            matches!(
                arg,
                FnArg::Typed(pat_type)
                    if matches!(
                        &*pat_type.pat,
                        Pat::Ident(pat_ident)
                            if LINE_CHUNK_IDENTIFIERS.iter().any(|name| pat_ident.ident == *name)
                    )
            )
        })
}

fn receiver_is_line_or_split_iter(expr: &Expr) -> bool {
    let Expr::MethodCall(call) = expr else {
        return false;
    };
    matches!(
        call.method.to_string().as_str(),
        "lines" | "split" | "split_whitespace"
    ) || receiver_is_line_or_split_iter(&call.receiver)
}

fn extract_serde_decode_call(expr: &Expr) -> Option<(&ExprCall, String)> {
    let Expr::Call(call) = expr else {
        return None;
    };
    let Expr::Path(callee) = &*call.func else {
        return None;
    };
    let segs: Vec<&syn::Ident> = callee.path.segments.iter().map(|s| &s.ident).collect();
    if segs.len() < 2 {
        return None;
    }
    let crate_seg = segs[segs.len() - 2];
    let fn_seg = segs[segs.len() - 1];
    let is_serde_crate = *crate_seg == "serde_json"
        || *crate_seg == "yaml_serde"
        || *crate_seg == "serde_yaml"
        || *crate_seg == "toml";
    let is_decode_fn = *fn_seg == "from_str"
        || *fn_seg == "from_slice"
        || *fn_seg == "from_reader"
        || *fn_seg == "from_value";
    (is_serde_crate && is_decode_fn).then(|| (call, format!("{crate_seg}::{fn_seg}")))
}

fn arg_mentions_line_or_chunk(expr: &Expr) -> bool {
    match expr {
        Expr::Reference(reference) => arg_mentions_line_or_chunk(&reference.expr),
        Expr::Paren(paren) => arg_mentions_line_or_chunk(&paren.expr),
        Expr::MethodCall(call) => arg_mentions_line_or_chunk(&call.receiver),
        Expr::Path(expr_path) => expr_path
            .path
            .segments
            .last()
            .is_some_and(|seg| LINE_CHUNK_IDENTIFIERS.iter().any(|name| seg.ident == *name)),
        _ => false,
    }
}

fn is_ok_tuple_pat(pat: &Pat) -> bool {
    matches!(
        pat,
        Pat::TupleStruct(tuple)
            if tuple.path.segments.last().is_some_and(|seg| seg.ident == "Ok")
    )
}
