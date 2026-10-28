use super::RustDiagnostic;
use super::smells::check_smells;
use proc_macro2::Span;
use std::path::Path;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Expr, ExprCall, ExprMethodCall, ExprPath, GenericArgument, Item, ItemFn, ItemMod,
    ItemStruct, ItemUse, Lit, Macro, Meta, PathArguments, Stmt, Type, TypePath, UseTree,
};

const BOUNDARY_DECODER_FILES: &[&str] = &[
    "rule_scope.rs",
    "batch.rs",
    "json_manifest.rs",
    "provenance.rs",
    "registries.rs",
];

const STRINGLY_VARIANT_FIELDS: &[&str] = &[
    "kind",
    "mode",
    "status",
    "variant",
    "category",
    "classification",
];

const UNTYPED_VALUE_METHODS: &[&str] = &[
    "as_u64",
    "as_i64",
    "as_f64",
    "as_bool",
    "as_array",
    "as_object",
];

pub(super) fn check_syn_ast(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    check_hollow_module(rel_path, path, ast, diagnostics);
    check_smells(rel_path, path, ast, diagnostics);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let mut visitor = AstRuleVisitor {
        rel_path,
        file_name,
        kernel_layer: kernel_layer_of(rel_path),
        crate_name: crate_name_of(rel_path),
        diagnostics,
    };
    visitor.visit_file(ast);
}

fn check_hollow_module(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") {
        return;
    }
    if ast.items.is_empty() {
        diagnostics.push(RustDiagnostic {
            file: rel_path.to_string(),
            line: 1,
            rule_id: "rust/no-hollow-module",
            message: "Module contains no items; delete hollow stub modules.".to_string(),
        });
        return;
    }
    let mut fn_count = 0usize;
    for item in &ast.items {
        match item {
            Item::Use(_) => {}
            Item::Fn(item_fn) => {
                fn_count += 1;
                if !is_hollow_fn_body(item_fn) {
                    return;
                }
            }
            _ => return,
        }
    }
    if fn_count > 0 {
        diagnostics.push(RustDiagnostic {
            file: rel_path.to_string(),
            line: 1,
            rule_id: "rust/no-hollow-module",
            message:
                "Module functions only return empty stub literals; implement real behavior or delete the module."
                    .to_string(),
        });
    }
}

fn is_hollow_fn_body(item_fn: &ItemFn) -> bool {
    let stmts = &item_fn.block.stmts;
    if stmts.is_empty() {
        return true;
    }
    if stmts.len() != 1 {
        return false;
    }
    let Stmt::Expr(expr, _) = &stmts[0] else {
        return false;
    };
    is_empty_stub_expr(expr)
}

fn is_empty_stub_expr(expr: &Expr) -> bool {
    match expr {
        Expr::Lit(expr_lit) => {
            matches!(&expr_lit.lit, Lit::Str(lit_str) if lit_str.value().is_empty())
        }
        Expr::Path(expr_path) => path_ends_with(&expr_path.path, &["None"]),
        Expr::Call(expr_call) => {
            if !expr_call.args.is_empty() {
                return false;
            }
            let Expr::Path(callee) = &*expr_call.func else {
                return false;
            };
            path_ends_with(&callee.path, &["Vec", "new"])
                || path_ends_with(&callee.path, &["Default", "default"])
                || path_ends_with(&callee.path, &["String", "new"])
        }
        Expr::Macro(expr_macro) => is_empty_vec_macro(&expr_macro.mac),
        _ => false,
    }
}

fn is_empty_vec_macro(mac: &Macro) -> bool {
    path_ends_with(&mac.path, &["vec"]) && mac.tokens.is_empty()
}

fn path_ends_with(path: &syn::Path, expected: &[&str]) -> bool {
    let segments: Vec<String> = path
        .segments
        .iter()
        .map(|seg| seg.ident.to_string())
        .collect();
    if segments.len() < expected.len() {
        return false;
    }
    let tail = &segments[segments.len() - expected.len()..];
    tail.iter()
        .zip(expected.iter())
        .all(|(actual, want)| actual == want)
}

fn crate_name_of(rel_path: &str) -> Option<&str> {
    let rest = rel_path.strip_prefix("crates/")?;
    rest.split('/').next()
}

fn kernel_layer_of(rel_path: &str) -> Option<(&'static str, u8)> {
    let rest = rel_path.strip_prefix("crates/antidrift-kernel/src/")?;
    let head = rest.split(['/', '.']).next()?;
    layer_rank(head)
}

fn layer_rank(segment: &str) -> Option<(&'static str, u8)> {
    match segment {
        "provenance" => Some(("provenance", 1)),
        "shape" => Some(("shape", 2)),
        "projection" => Some(("projection", 3)),
        "boundary" => Some(("boundary", 4)),
        "callgraph" => Some(("callgraph", 5)),
        _ => None,
    }
}

struct AstRuleVisitor<'a> {
    rel_path: &'a str,
    file_name: &'a str,
    kernel_layer: Option<(&'static str, u8)>,
    crate_name: Option<&'a str>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl AstRuleVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic {
            file: self.rel_path.to_string(),
            line: span.start().line.max(1),
            rule_id,
            message,
        });
    }

    fn check_attributes(&mut self, attrs: &[Attribute]) {
        for attr in attrs {
            if is_banned_test_attribute(attr) {
                self.push(
                    attr.span(),
                    "rust/no-inline-tests",
                    "Inline #[test], #[tokio::test], and #[cfg(test)] blocks are forbidden; validate via real CLI smoke runs.".to_string(),
                );
            }
        }
    }

    fn check_module_path(&mut self, segments: &[String], span: Span) {
        if segments.is_empty() {
            return;
        }
        if let Some(crate_name) = self.crate_name {
            let root = segments[0].as_str();
            if crate_name == "antidrift-kernel"
                && matches!(root, "antidrift_rules" | "antidrift_linter")
            {
                self.push(
                    span,
                    "rust/no-layer-violation",
                    format!("antidrift-kernel cannot depend on {root}."),
                );
            } else if crate_name == "antidrift-rules" && root == "antidrift_linter" {
                self.push(
                    span,
                    "rust/no-layer-violation",
                    "antidrift-rules cannot depend on antidrift_linter.".to_string(),
                );
            }
        }
        let Some((src_name, src_rank)) = self.kernel_layer else {
            return;
        };
        let target_candidate = match segments.first().map(String::as_str) {
            Some("crate" | "super") => segments.get(1).map(String::as_str),
            _ => None,
        };
        let Some(target_seg) = target_candidate else {
            return;
        };
        let Some((target_name, target_rank)) = layer_rank(target_seg) else {
            return;
        };
        if target_rank > src_rank {
            self.push(
                span,
                "rust/no-layer-violation",
                format!(
                    "Kernel layer '{src_name}' (rank {src_rank}) cannot import higher layer '{target_name}' (rank {target_rank})."
                ),
            );
        }
    }
}

impl<'ast> Visit<'ast> for AstRuleVisitor<'_> {
    fn visit_item_mod(&mut self, node: &'ast ItemMod) {
        self.check_attributes(&node.attrs);
        visit::visit_item_mod(self, node);
    }

    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        self.check_attributes(&node.attrs);
        visit::visit_item_fn(self, node);
    }

    fn visit_item_use(&mut self, node: &'ast ItemUse) {
        self.check_attributes(&node.attrs);
        let mut prefix = Vec::new();
        let mut collected = Vec::new();
        flatten_use_tree(&node.tree, &mut prefix, &mut collected);
        for (segments, span) in collected {
            self.check_module_path(&segments, span);
        }
        visit::visit_item_use(self, node);
    }

    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        let segments: Vec<String> = node
            .path
            .segments
            .iter()
            .map(|seg| seg.ident.to_string())
            .collect();
        self.check_module_path(&segments, node.span());
        visit::visit_expr_path(self, node);
    }

    fn visit_type_path(&mut self, node: &'ast TypePath) {
        let segments: Vec<String> = node
            .path
            .segments
            .iter()
            .map(|seg| seg.ident.to_string())
            .collect();
        self.check_module_path(&segments, node.span());
        if let Some(last) = node.path.segments.last() {
            let ident = last.ident.to_string();
            if matches!(ident.as_str(), "HashMap" | "FxHashMap" | "BTreeMap")
                && has_bool_second_type_arg(&last.arguments)
            {
                self.push(
                    last.span(),
                    "rust/no-boolean-map",
                    format!(
                        "{ident}<K, bool> is a two-state boolean map; use a Set<K> or a closed state enum instead."
                    ),
                );
            }
        }
        visit::visit_type_path(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        self.check_attributes(&node.attrs);
        if derives_deserialize(&node.attrs) && !has_serde_deny_unknown_fields(&node.attrs) {
            self.push(
                node.ident.span(),
                "rust/require-strict-serde",
                format!(
                    "Struct '{}' derives Deserialize without #[serde(deny_unknown_fields)].",
                    node.ident
                ),
            );
        }
        for field in &node.fields {
            let Some(ident) = &field.ident else {
                continue;
            };
            let name = ident.to_string();
            if STRINGLY_VARIANT_FIELDS.contains(&name.as_str()) && is_string_or_str_type(&field.ty)
            {
                self.push(
                    ident.span(),
                    "rust/no-stringly-variant",
                    format!(
                        "Struct '{}' field '{name}' uses a stringly discriminant; replace with a closed enum.",
                        node.ident
                    ),
                );
            }
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if !BOUNDARY_DECODER_FILES.contains(&self.file_name) {
            let method = node.method.to_string();
            if UNTYPED_VALUE_METHODS.contains(&method.as_str()) {
                self.push(
                    node.method.span(),
                    "rust/no-untyped-config-probe",
                    format!(
                        "Untyped JSON probe '.{method}()' outside boundary decoder; deserialize once via decode_rule_options."
                    ),
                );
            } else if method == "and_then" && is_string_key_get_call(&node.receiver) {
                self.push(
                    node.method.span(),
                    "rust/no-untyped-config-probe",
                    "Untyped '.get(\"...\").and_then(...)' config probe outside boundary decoder; deserialize once via decode_rule_options.".to_string(),
                );
            }
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if self.crate_name == Some("antidrift-rules") && is_source_file_listener_call(node) {
            self.push(
                node.span(),
                "antidrift/no-tsrslint-sourcefile-listener",
                "Listener::Enter(Kind::SourceFile) and Listener::Exit(Kind::SourceFile) never fire in tsrslint; attach listeners to statement/declaration kinds or use post-walk state.".to_string(),
            );
        }
        visit::visit_expr_call(self, node);
    }
}

fn flatten_use_tree(tree: &UseTree, prefix: &mut Vec<String>, out: &mut Vec<(Vec<String>, Span)>) {
    match tree {
        UseTree::Path(use_path) => {
            prefix.push(use_path.ident.to_string());
            flatten_use_tree(&use_path.tree, prefix, out);
            prefix.pop();
        }
        UseTree::Name(use_name) => {
            let mut full = prefix.clone();
            full.push(use_name.ident.to_string());
            out.push((full, use_name.ident.span()));
        }
        UseTree::Rename(use_rename) => {
            let mut full = prefix.clone();
            full.push(use_rename.ident.to_string());
            out.push((full, use_rename.ident.span()));
        }
        UseTree::Glob(use_glob) => {
            out.push((prefix.clone(), use_glob.star_token.span));
        }
        UseTree::Group(use_group) => {
            for item in &use_group.items {
                flatten_use_tree(item, prefix, out);
            }
        }
    }
}

fn is_banned_test_attribute(attr: &Attribute) -> bool {
    let path = attr.path();
    if path.is_ident("test") || path_ends_with(path, &["tokio", "test"]) {
        return true;
    }
    if !path.is_ident("cfg") {
        return false;
    }
    let Ok(nested) = attr.parse_args::<Meta>() else {
        return false;
    };
    nested.path().is_ident("test")
}

fn derives_deserialize(attrs: &[Attribute]) -> bool {
    for attr in attrs {
        if !attr.path().is_ident("derive") {
            continue;
        }
        let mut found = false;
        let parsed = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("Deserialize")
                || path_ends_with(&meta.path, &["serde", "Deserialize"])
            {
                found = true;
            }
            Ok(())
        });
        if parsed.is_ok() && found {
            return true;
        }
    }
    false
}

fn has_serde_deny_unknown_fields(attrs: &[Attribute]) -> bool {
    for attr in attrs {
        if !attr.path().is_ident("serde") {
            continue;
        }
        let mut found = false;
        let parsed = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("deny_unknown_fields") {
                found = true;
            }
            if meta.input.peek(syn::token::Eq) {
                let _: syn::Token![=] = meta.input.parse()?;
                let _: Expr = meta.input.parse()?;
            }
            Ok(())
        });
        if parsed.is_ok() && found {
            return true;
        }
    }
    false
}

fn is_string_or_str_type(ty: &Type) -> bool {
    match ty {
        Type::Path(type_path) => {
            path_ends_with(&type_path.path, &["String"])
                || path_ends_with(&type_path.path, &["str"])
        }
        Type::Reference(type_ref) => is_string_or_str_type(&type_ref.elem),
        _ => false,
    }
}

fn has_bool_second_type_arg(args: &PathArguments) -> bool {
    let PathArguments::AngleBracketed(angle) = args else {
        return false;
    };
    let mut type_args = angle.args.iter().filter_map(|arg| match arg {
        GenericArgument::Type(ty) => Some(ty),
        _ => None,
    });
    let _first = type_args.next();
    let Some(Type::Path(second)) = type_args.next() else {
        return false;
    };
    second.path.is_ident("bool")
}

fn is_string_key_get_call(expr: &Expr) -> bool {
    let Expr::MethodCall(call) = expr else {
        return false;
    };
    if call.method != "get" || call.args.len() != 1 {
        return false;
    }
    matches!(&call.args[0], Expr::Lit(expr_lit) if matches!(&expr_lit.lit, Lit::Str(_)))
}

fn is_source_file_listener_call(call: &ExprCall) -> bool {
    if call.args.len() != 1 {
        return false;
    }
    let Expr::Path(callee) = &*call.func else {
        return false;
    };
    let is_listener_ctor = path_ends_with(&callee.path, &["Listener", "Enter"])
        || path_ends_with(&callee.path, &["Listener", "Exit"]);
    if !is_listener_ctor {
        return false;
    }
    let Expr::Path(arg_path) = &call.args[0] else {
        return false;
    };
    path_ends_with(&arg_path.path, &["Kind", "SourceFile"])
}
