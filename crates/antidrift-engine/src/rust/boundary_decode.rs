use super::RustDiagnostic;
use super::syn_kernel::{
    derives_deserialize, has_derive_or_repr, has_serde_deny_unknown_fields, is_ok_tuple_pat,
};
use antidrift_kernel::decode_guards::{
    is_line_chunk_identifier, is_parser_module_path, is_sniffed_text_identifier,
    is_sniffer_function_name,
};
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Block, Expr, ExprCall, ExprForLoop, ExprIf, ExprLet, ExprLoop, ExprMethodCall,
    ExprWhile, Fields, FnArg, ImplItemFn, Item, ItemEnum, ItemFn, ItemStruct, Pat, ReturnType,
    Type,
};

pub(super) fn check_decode_to_option(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    if is_parser_module_path(rel_path) {
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
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            "rust/no-decode-to-option",
            format!(
                "Boundary decode '{callee}' is collapsed via '{suppression}', erasing schema/syntax failures into absence or a silent default; propagate or report the decode error explicitly."
            ),
        ));
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
        ) && !(method_name == "unwrap_or_else" && closure_arg_diverges(&node.args))
            && let Some((decode_call, callee_label)) = extract_serde_decode_call(&node.receiver)
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
    is_sniffer_function_name(fn_name)
        || inputs.iter().any(|arg| {
            matches!(
                arg,
                FnArg::Typed(pat_type)
                    if matches!(
                        &*pat_type.pat,
                        Pat::Ident(pat_ident)
                            if is_sniffed_input_name(&pat_ident.ident.to_string())
                    )
            )
        })
}

fn is_sniffed_input_name(name: &str) -> bool {
    is_line_chunk_identifier(name) || is_sniffed_text_identifier(name)
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

pub(super) fn extract_serde_decode_call(expr: &Expr) -> Option<(&ExprCall, String)> {
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
            .is_some_and(|seg| is_sniffed_input_name(&seg.ident.to_string())),
        _ => false,
    }
}

fn closure_arg_diverges(args: &syn::punctuated::Punctuated<Expr, syn::Token![,]>) -> bool {
    let Some(Expr::Closure(closure)) = args.first() else {
        return false;
    };
    expr_diverges(&closure.body)
}

fn expr_diverges(expr: &Expr) -> bool {
    match expr {
        Expr::Macro(mac) => mac.mac.path.segments.last().is_some_and(|seg| {
            seg.ident == "panic" || seg.ident == "unreachable" || seg.ident == "todo"
        }),
        Expr::Return(_) | Expr::Break(_) | Expr::Continue(_) => true,
        Expr::Block(block) => block.block.stmts.last().is_some_and(|stmt| match stmt {
            syn::Stmt::Expr(e, _) => expr_diverges(e),
            syn::Stmt::Macro(m) => m.mac.path.segments.last().is_some_and(|seg| {
                seg.ident == "panic" || seg.ident == "unreachable" || seg.ident == "todo"
            }),
            _ => false,
        }),
        _ => false,
    }
}

pub(super) fn check_strict_serde(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let default_helper_return_types = collect_default_helper_return_types(&ast.items);
    StrictSerdeVisitor {
        rel_path,
        default_helper_return_types,
        diagnostics,
    }
    .visit_file(ast);
}

struct StrictSerdeVisitor<'a> {
    rel_path: &'a str,
    default_helper_return_types: Vec<String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl StrictSerdeVisitor<'_> {
    fn push(&mut self, span: Span, message: String) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            "rust/require-strict-serde",
            message,
        ));
    }

    fn check_duplicate_default(
        &mut self,
        kind: &str,
        ident: &syn::Ident,
        attrs: &[Attribute],
        has_field_default: bool,
    ) {
        let name = ident.to_string();
        if has_derive_or_repr(attrs, &["Default"])
            && (self.default_helper_return_types.contains(&name)
                || attrs_have_serde_default_fn(attrs)
                || has_field_default)
        {
            self.push(
                ident.span(),
                format!(
                    "{kind} '{name}' derives Default alongside a custom default helper; own defaults in one place."
                ),
            );
        }
    }
}

impl<'ast> Visit<'ast> for StrictSerdeVisitor<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        let Some((_, items)) = &node.content else {
            return;
        };
        let prev = std::mem::replace(
            &mut self.default_helper_return_types,
            collect_default_helper_return_types(items),
        );
        visit::visit_item_mod(self, node);
        self.default_helper_return_types = prev;
    }

    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        check_decode_then_validate(self.rel_path, &node.block, self.diagnostics);
        visit::visit_item_fn(self, node);
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        check_decode_then_validate(self.rel_path, &node.block, self.diagnostics);
        visit::visit_impl_item_fn(self, node);
    }

    fn visit_item_enum(&mut self, node: &'ast ItemEnum) {
        self.check_duplicate_default("Enum", &node.ident, &node.attrs, false);
        visit::visit_item_enum(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        if derives_deserialize(&node.attrs)
            && !has_serde_deny_unknown_fields(&node.attrs)
            && admits_unknown_fields(node)
        {
            self.push(
                node.ident.span(),
                format!(
                    "Struct '{}' derives Deserialize without #[serde(deny_unknown_fields)].",
                    node.ident
                ),
            );
        }
        let has_field_default = node
            .fields
            .iter()
            .any(|field| attrs_have_serde_default_fn(&field.attrs));
        self.check_duplicate_default("Struct", &node.ident, &node.attrs, has_field_default);
        visit::visit_item_struct(self, node);
    }
}

fn admits_unknown_fields(node: &ItemStruct) -> bool {
    let Fields::Named(named) = &node.fields else {
        return false;
    };
    !attrs_mention_serde(&node.attrs, &["transparent", "from", "try_from"])
        && !named
            .named
            .iter()
            .any(|field| attrs_mention_serde(&field.attrs, &["flatten"]))
}

fn attrs_mention_serde(attrs: &[Attribute], keys: &[&str]) -> bool {
    attrs
        .iter()
        .filter(|attr| attr.path().is_ident("serde"))
        .any(|attr| {
            let mut found = false;
            let parsed = attr.parse_nested_meta(|meta| {
                found |= keys.iter().any(|key| meta.path.is_ident(key));
                if meta.input.peek(syn::Token![=]) {
                    meta.input.parse::<syn::Token![=]>()?;
                    meta.input.parse::<Expr>()?;
                }
                Ok(())
            });
            parsed.is_ok() && found
        })
}

fn collect_default_helper_return_types(items: &[Item]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match item {
            Item::Fn(item_fn) if item_fn.sig.ident.to_string().starts_with("default_") => {
                match &item_fn.sig.output {
                    ReturnType::Type(_, ret_ty) => match &**ret_ty {
                        Type::Path(tp) => tp.path.segments.last().map(|s| s.ident.to_string()),
                        _ => None,
                    },
                    ReturnType::Default => None,
                }
            }
            _ => None,
        })
        .collect()
}

fn attrs_have_serde_default_fn(attrs: &[Attribute]) -> bool {
    attrs
        .iter()
        .filter(|attr| attr.path().is_ident("serde"))
        .any(serde_attr_has_default_fn)
}

fn serde_attr_has_default_fn(attr: &Attribute) -> bool {
    let mut has_default_path = false;
    let parsed = attr.parse_nested_meta(|meta| {
        has_default_path |= meta.path.is_ident("default") && meta.input.peek(syn::Token![=]);
        if meta.input.peek(syn::Token![=]) {
            meta.input.parse::<syn::Token![=]>()?;
            meta.input.parse::<Expr>()?;
        }
        Ok(())
    });
    parsed.is_ok() && has_default_path
}

fn check_decode_then_validate(
    rel_path: &str,
    block: &Block,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    struct DecodeValidateFinder {
        has_decode: bool,
        validate_span: Option<Span>,
    }
    impl<'ast> Visit<'ast> for DecodeValidateFinder {
        fn visit_item(&mut self, _node: &'ast Item) {}
        fn visit_expr_call(&mut self, node: &'ast ExprCall) {
            visit::visit_expr_call(self, node);
            if extract_serde_decode_call(&Expr::Call(node.clone())).is_some() {
                self.has_decode = true;
                return;
            }
            if self.has_decode
                && let Expr::Path(callee) = &*node.func
                && let Some(last) = callee.path.segments.last()
                && (last.ident == "validate" || last.ident.to_string().starts_with("validate_"))
            {
                self.validate_span.get_or_insert_with(|| last.ident.span());
            }
        }
        fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
            visit::visit_expr_method_call(self, node);
            let name = node.method.to_string();
            if self.has_decode && (name == "validate" || name.starts_with("validate_")) {
                self.validate_span.get_or_insert_with(|| node.method.span());
            }
        }
    }
    let mut finder = DecodeValidateFinder {
        has_decode: false,
        validate_span: None,
    };
    finder.visit_block(block);
    if finder.has_decode
        && let Some(span) = finder.validate_span
    {
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            span.start().line.max(1),
            "rust/require-strict-serde",
            "Function decodes with serde and then calls validate; enforce invariants during deserialization (#[serde(deserialize_with = ...)] or #[serde(try_from = ...)]) instead of post-decode .validate().".to_owned(),
        ));
    }
}
