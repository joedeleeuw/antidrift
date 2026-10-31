use super::RustDiagnostic;
use super::config::{ForbiddenCall, RustConfig};
use super::syn_kernel::{
    derives_deserialize, has_serde_deny_unknown_fields, is_banned_test_attribute, path_ends_with,
};
use proc_macro2::Span;
use std::path::Path;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Expr, ExprCall, ExprPath, Fields, GenericArgument, Item, ItemFn, ItemMod,
    ItemStruct, ItemUse, Lit, Macro, PathArguments, Stmt, Type, TypePath, UseTree,
};

const STRINGLY_VARIANT_FIELDS: &[&str] = &[
    "kind",
    "mode",
    "status",
    "variant",
    "category",
    "classification",
];

pub(super) struct CrateLayer<'a> {
    pub(super) crate_name: Option<&'a str>,
    pub(super) top_module: Option<&'a str>,
}

pub(super) fn check_syn_ast(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    config: &RustConfig,
    layer: &CrateLayer<'_>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    check_hollow_module(rel_path, path, ast, diagnostics);
    let crate_rank = layer.crate_name.and_then(|name| {
        config
            .layers
            .crates
            .iter()
            .position(|candidate| candidate == name)
    });
    let module_ranks = layer
        .crate_name
        .and_then(|name| config.layers.modules.get(name))
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let module_rank = layer.top_module.and_then(|module| {
        module_ranks
            .iter()
            .position(|candidate| candidate == module)
    });
    let mut visitor = AstRuleVisitor {
        rel_path,
        crate_rank,
        crate_layers: &config.layers.crates,
        module_rank,
        module_ranks,
        forbidden_calls: &config.forbidden_calls,
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
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            1,
            "rust/no-hollow-module",
            "Module contains no items; delete hollow stub modules.".to_owned(),
        ));
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
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            1,
            "rust/no-hollow-module",
            "Module functions only return empty stub literals; implement real behavior or delete the module.".to_owned(),
        ));
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

struct AstRuleVisitor<'a> {
    rel_path: &'a str,
    crate_rank: Option<usize>,
    crate_layers: &'a [String],
    module_rank: Option<usize>,
    module_ranks: &'a [String],
    forbidden_calls: &'a [ForbiddenCall],
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl AstRuleVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: String) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message,
        ));
    }

    fn check_attributes(&mut self, attrs: &[Attribute]) {
        for attr in attrs {
            if is_banned_test_attribute(attr) {
                self.push(
                    attr.span(),
                    "rust/no-inline-tests",
                    "Inline #[test], #[tokio::test], and #[cfg(test)] blocks are forbidden; validate via real CLI smoke runs.".to_owned(),
                );
            }
        }
    }

    fn check_module_path(&mut self, segments: &[String], span: Span) {
        let Some(root) = segments.first() else {
            return;
        };
        if let Some(crate_rank) = self.crate_rank
            && let Some(target_rank) = self
                .crate_layers
                .iter()
                .position(|name| name.replace('-', "_") == *root)
            && target_rank > crate_rank
        {
            self.push(
                span,
                "rust/no-layer-violation",
                format!(
                    "Crate layer {crate_rank} cannot use '{}' (layer {target_rank}); layers.crates in the antidrift metadata orders crates from lowest to highest.",
                    self.crate_layers[target_rank]
                ),
            );
        }
        let Some(module_rank) = self.module_rank else {
            return;
        };
        let target_candidate = match root.as_str() {
            "crate" | "super" => segments.get(1),
            _ => None,
        };
        let Some(target_rank) = target_candidate.and_then(|target| {
            self.module_ranks
                .iter()
                .position(|candidate| candidate == target)
        }) else {
            return;
        };
        if target_rank > module_rank {
            self.push(
                span,
                "rust/no-layer-violation",
                format!(
                    "Module layer '{}' (rank {module_rank}) cannot import higher layer '{}' (rank {target_rank}); layers.modules in the antidrift metadata orders modules from lowest to highest.",
                    self.module_ranks[module_rank], self.module_ranks[target_rank]
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
        if let Some(last) = node.path.segments.last()
            && (last.ident == "HashMap" || last.ident == "FxHashMap" || last.ident == "BTreeMap")
            && has_bool_second_type_arg(&last.arguments)
        {
            self.push(
                last.span(),
                "rust/no-boolean-map",
                format!(
                    "{}<K, bool> is a two-state boolean map; use a Set<K> or a closed state enum instead.",
                    last.ident
                ),
            );
        }
        visit::visit_type_path(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        self.check_attributes(&node.attrs);
        if derives_deserialize(&node.attrs)
            && !has_serde_deny_unknown_fields(&node.attrs)
            && admits_unknown_fields(node)
        {
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
            if STRINGLY_VARIANT_FIELDS.iter().any(|name| ident == *name)
                && is_string_or_str_type(&field.ty)
            {
                self.push(
                    ident.span(),
                    "rust/no-stringly-variant",
                    format!(
                        "Struct '{}' field '{ident}' uses a stringly discriminant; replace with a closed enum.",
                        node.ident
                    ),
                );
            }
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Some(forbidden) = matching_forbidden_call(self.forbidden_calls, node) {
            self.push(
                node.span(),
                "rust/no-forbidden-call",
                format!(
                    "'{}' is forbidden here: {}",
                    forbidden.callee, forbidden.reason
                ),
            );
        }
        visit::visit_expr_call(self, node);
    }
}

fn admits_unknown_fields(node: &ItemStruct) -> bool {
    let Fields::Named(named) = &node.fields else {
        return false;
    };
    let container_reshaped = node
        .attrs
        .iter()
        .filter(|attr| attr.path().is_ident("serde"))
        .any(|attr| serde_attr_mentions(attr, &["transparent", "from", "try_from"]));
    let has_flatten = named.named.iter().any(|field| {
        field
            .attrs
            .iter()
            .filter(|attr| attr.path().is_ident("serde"))
            .any(|attr| serde_attr_mentions(attr, &["flatten"]))
    });
    !container_reshaped && !has_flatten
}

fn serde_attr_mentions(attr: &Attribute, keys: &[&str]) -> bool {
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
}

fn matching_forbidden_call<'a>(
    forbidden_calls: &'a [ForbiddenCall],
    call: &ExprCall,
) -> Option<&'a ForbiddenCall> {
    let Expr::Path(callee) = &*call.func else {
        return None;
    };
    forbidden_calls.iter().find(|forbidden| {
        let callee_segments: Vec<&str> = forbidden.callee.split("::").collect();
        if !path_ends_with(&callee.path, &callee_segments) {
            return false;
        }
        let Some(argument) = &forbidden.argument else {
            return true;
        };
        let argument_segments: Vec<&str> = argument.split("::").collect();
        call.args.len() == 1
            && matches!(&call.args[0], Expr::Path(arg_path) if path_ends_with(&arg_path.path, &argument_segments))
    })
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
