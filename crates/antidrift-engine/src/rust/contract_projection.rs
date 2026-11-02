use super::RustDiagnostic;
use super::syn_ast::extract_pat_ident;
use super::type_aliases::{TypeAliases, last_type_segment};
use antidrift_kernel::outcome_shape::{
    OutcomeArm, find_sum_to_product_pair, is_outcome_error_field, is_outcome_flag_field,
    outcome_shape_key,
};
use proc_macro2::Span;
use rustc_hash::FxHashMap;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Arm, Expr, ExprField, ExprIf, ExprLet, ExprLit, ExprStruct, FnArg, ImplItemFn, ItemFn, Lit,
    Local, Member, Pat, Signature,
};

pub(super) fn check_contract_projections(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let type_aliases = TypeAliases::collect(&ast.items);
    let mut visitor = ContractProjectionVisitor {
        rel_path,
        type_aliases,
        outcome_arms: Vec::new(),
        impl_type: None,
        param_types: FxHashMap::default(),
        diagnostics,
    };
    visitor.visit_file(ast);
}

struct ContractProjectionVisitor<'a> {
    rel_path: &'a str,
    type_aliases: TypeAliases,
    outcome_arms: Vec<(OutcomeArm, Span)>,
    impl_type: Option<String>,
    param_types: FxHashMap<String, String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl ContractProjectionVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message.into(),
        ));
    }

    fn visit_fn_scope(&mut self, signature: &Signature, body: impl FnOnce(&mut Self)) {
        let prev = (
            std::mem::take(&mut self.outcome_arms),
            std::mem::take(&mut self.param_types),
        );
        for input in &signature.inputs {
            if let FnArg::Typed(typed) = input
                && let Some((name, _)) = extract_pat_ident(&typed.pat)
                && let Some(type_name) = last_type_segment(&typed.ty)
            {
                self.param_types.insert(name, type_name);
            }
        }
        body(self);
        self.report_sum_to_product_arms();
        (self.outcome_arms, self.param_types) = prev;
    }

    fn source_type_of(&self, binding: &str) -> Option<&str> {
        if binding == "self" {
            return self.impl_type.as_deref();
        }
        self.param_types.get(binding).map(String::as_str)
    }

    fn is_cross_type_rebuild(&self, node: &ExprStruct, source_binding: &str) -> bool {
        if is_enum_variant_path(&node.path) {
            return true;
        }
        let Some(target) = qualified_struct_path(&node.path, self.impl_type.as_deref()) else {
            return false;
        };
        match self.source_type_of(source_binding) {
            Some(source) => {
                self.type_aliases.canonical(&target) != self.type_aliases.canonical(source)
            }
            None => false,
        }
    }

    fn report_sum_to_product_arms(&mut self) {
        let arms: Vec<OutcomeArm> = self
            .outcome_arms
            .iter()
            .map(|(arm, _)| arm.clone())
            .collect();
        let Some((ok_index, err_index)) = find_sum_to_product_pair(&arms) else {
            return;
        };
        let ok_line = self.outcome_arms[ok_index].1.start().line.max(1);
        let (err_arm, err_span) = &self.outcome_arms[err_index];
        let record = err_arm
            .shape
            .split('{')
            .next()
            .unwrap_or_default()
            .to_owned();
        self.push(
            *err_span,
            "rust/no-contract-appeasement-projection",
            format!(
                "Success and failure arms (lines {ok_line} and {}) both build '{record}' with complementary flag and error fields; return a typed outcome enum or Result instead of a product bag.",
                err_span.start().line.max(1)
            ),
        );
    }
}

impl<'ast> Visit<'ast> for ContractProjectionVisitor<'_> {
    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let previous = std::mem::replace(&mut self.impl_type, last_type_segment(&node.self_ty));
        visit::visit_item_impl(self, node);
        self.impl_type = previous;
    }

    fn visit_item_fn(&mut self, node: &'ast ItemFn) {
        self.visit_fn_scope(&node.sig, |this| visit::visit_item_fn(this, node));
    }

    fn visit_impl_item_fn(&mut self, node: &'ast ImplItemFn) {
        self.visit_fn_scope(&node.sig, |this| visit::visit_impl_item_fn(this, node));
    }

    fn visit_arm(&mut self, node: &'ast Arm) {
        let prev = self.param_types.clone();
        collect_pattern_types(&node.pat, self.impl_type.as_deref(), &mut self.param_types);
        visit::visit_arm(self, node);
        self.param_types = prev;
    }

    fn visit_expr_if(&mut self, node: &'ast ExprIf) {
        let prev = self.param_types.clone();
        if let Expr::Let(ExprLet { pat, .. }) = &*node.cond {
            collect_pattern_types(pat, self.impl_type.as_deref(), &mut self.param_types);
        }
        visit::visit_expr_if(self, node);
        self.param_types = prev;
    }

    fn visit_local(&mut self, node: &'ast Local) {
        collect_pattern_types(&node.pat, self.impl_type.as_deref(), &mut self.param_types);
        visit::visit_local(self, node);
    }

    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        if let Some(arm) = outcome_arm(node) {
            self.outcome_arms.push((arm, node.path.span()));
        }
        if let Some(src_ident) = detect_fieldwise_clone_rebuild(node)
            && !self.is_cross_type_rebuild(node, &src_ident)
            && let Some(seg) = node.path.segments.last()
        {
            self.push(
                node.path.span(),
                "rust/no-contract-appeasement-projection",
                format!(
                    "Struct '{}' is rebuilt field-by-field via '.clone()' from '{src_ident}'; call '{src_ident}.clone()' directly.",
                    seg.ident
                ),
            );
        }
        visit::visit_expr_struct(self, node);
    }
}

fn is_enum_variant_path(path: &syn::Path) -> bool {
    let len = path.segments.len();
    if len < 2 {
        return false;
    }
    let prev = path.segments[len - 2].ident.to_string();
    prev == "Self" || prev.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
}

fn qualified_struct_path(path: &syn::Path, impl_type: Option<&str>) -> Option<String> {
    let segs: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
    let last = segs.last()?;
    if segs.len() == 1 {
        if last == "Self" {
            return impl_type.map(ToOwned::to_owned);
        }
        return Some(last.clone());
    }
    let prev = &segs[segs.len() - 2];
    if prev == "Self" {
        let owner = impl_type.unwrap_or("Self");
        return Some(format!("{owner}::{last}"));
    }
    if prev.bytes().next().is_some_and(|b| b.is_ascii_uppercase()) {
        return Some(format!("{prev}::{last}"));
    }
    Some(last.clone())
}

fn collect_tuple_struct_pattern_types(
    ts: &syn::PatTupleStruct,
    impl_type: Option<&str>,
    out: &mut FxHashMap<String, String>,
) {
    let last_name = ts.path.segments.last().map(|s| s.ident.to_string());
    if matches!(last_name.as_deref(), Some("Ok" | "Err" | "Some")) {
        for elem in &ts.elems {
            collect_pattern_types(elem, impl_type, out);
        }
        return;
    }
    let Some(origin) = qualified_struct_path(&ts.path, impl_type) else {
        return;
    };
    for elem in &ts.elems {
        if let Some((name, _)) = extract_pat_ident(elem) {
            out.insert(name, format!("payload_of:{origin}"));
        } else {
            collect_pattern_types(elem, impl_type, out);
        }
    }
}

fn collect_pattern_types(pat: &Pat, impl_type: Option<&str>, out: &mut FxHashMap<String, String>) {
    match pat {
        Pat::Type(pat_type) => {
            if let Some((name, _)) = extract_pat_ident(&pat_type.pat)
                && let Some(ty) = last_type_segment(&pat_type.ty)
            {
                out.insert(name, ty);
            } else {
                collect_pattern_types(&pat_type.pat, impl_type, out);
            }
        }
        Pat::TupleStruct(ts) => collect_tuple_struct_pattern_types(ts, impl_type, out),
        Pat::Struct(ps) => {
            for field in &ps.fields {
                collect_pattern_types(&field.pat, impl_type, out);
            }
        }
        Pat::Tuple(tuple) => {
            for elem in &tuple.elems {
                collect_pattern_types(elem, impl_type, out);
            }
        }
        Pat::Slice(slice) => {
            for elem in &slice.elems {
                collect_pattern_types(elem, impl_type, out);
            }
        }
        Pat::Or(or_pat) => {
            for case in &or_pat.cases {
                collect_pattern_types(case, impl_type, out);
            }
        }
        Pat::Reference(r) => collect_pattern_types(&r.pat, impl_type, out),
        Pat::Paren(p) => collect_pattern_types(&p.pat, impl_type, out),
        _ => {}
    }
}

fn outcome_arm(node: &ExprStruct) -> Option<OutcomeArm> {
    if node.rest.is_some() {
        return None;
    }
    let record = node.path.segments.last()?.ident.to_string();
    let (mut flag, mut error_present) = (None, None);
    let mut names = Vec::with_capacity(node.fields.len());
    for field in &node.fields {
        let Member::Named(ident) = &field.member else {
            return None;
        };
        let name = ident.to_string();
        if is_outcome_flag_field(&name)
            && let Expr::Lit(ExprLit {
                lit: Lit::Bool(literal),
                ..
            }) = &field.expr
        {
            flag = Some(literal.value);
        }
        if is_outcome_error_field(&name) {
            error_present = option_presence(&field.expr);
        }
        names.push(name);
    }
    Some(OutcomeArm {
        shape: outcome_shape_key(&record, names.iter().map(String::as_str)),
        flag: flag?,
        error_present: error_present?,
    })
}

fn option_presence(expr: &Expr) -> Option<bool> {
    match expr {
        Expr::Path(ep) if ep.path.is_ident("None") => Some(false),
        Expr::Call(call) => {
            matches!(&*call.func, Expr::Path(ep) if ep.path.is_ident("Some")).then_some(true)
        }
        _ => None,
    }
}

fn detect_fieldwise_clone_rebuild(node: &ExprStruct) -> Option<String> {
    if node.rest.is_some() || node.fields.len() < 3 {
        return None;
    }
    let (mut source_ident, mut clone_count) = (None, 0usize);
    for field in &node.fields {
        let Member::Named(field_ident) = &field.member else {
            return None;
        };
        let (base_ident, accessed_field, is_cloned) = extract_field_copy_or_clone(&field.expr)?;
        if *field_ident != accessed_field
            || source_ident.as_ref().is_some_and(|ex| ex != &base_ident)
        {
            return None;
        }
        source_ident = Some(base_ident);
        clone_count += usize::from(is_cloned);
    }
    (clone_count >= 2).then_some(source_ident?)
}

fn extract_field_copy_or_clone(expr: &Expr) -> Option<(String, String, bool)> {
    match expr {
        Expr::MethodCall(mc) if mc.method == "clone" && mc.args.is_empty() => {
            extract_field_copy_or_clone(&mc.receiver).map(|(b, f, _)| (b, f, true))
        }
        Expr::Field(ExprField {
            base,
            member: Member::Named(f),
            ..
        }) => match &**base {
            Expr::Path(ep) => Some((ep.path.get_ident()?.to_string(), f.to_string(), false)),
            _ => None,
        },
        _ => None,
    }
}
