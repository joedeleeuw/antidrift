use super::RustDiagnostic;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use syn::visit::{self, Visit};
use syn::{
    Attribute, BinOp, Expr, ExprAssign, ExprBinary, ExprField, ExprLit, ExprMethodCall, ExprPath,
    ExprReference, ExprStruct, Fields, GenericArgument, Item, ItemImpl, ItemStruct, Lit, Member,
    PathArguments, Type,
};

const MUTATING_FIELD_METHODS: &[&str] = &[
    "push",
    "push_str",
    "pop",
    "insert",
    "remove",
    "extend",
    "clear",
    "retain",
    "sort",
    "sort_by",
    "sort_unstable",
    "dedup",
    "truncate",
    "append",
    "get_or_insert",
    "get_or_insert_with",
    "entry",
    "take",
    "replace",
];

pub(super) fn check_structural_type_forks(
    workspace_root: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut seen: FxHashMap<Vec<(String, String)>, (String, String, usize)> = FxHashMap::default();
    for file_path in rs_files {
        let Some(ast) = parsed_files.get(file_path) else {
            continue;
        };
        let rel_path = relative_display(workspace_root, file_path);
        for item in &ast.items {
            let Item::Struct(item_struct) = item else {
                continue;
            };
            let Some(signature) = struct_field_signature(item_struct) else {
                continue;
            };
            let struct_name = item_struct.ident.to_string();
            let line = item_struct.ident.span().start().line.max(1);
            if let Some((owner_name, owner_file, owner_line)) = seen.get(&signature) {
                diagnostics.push(RustDiagnostic {
                    file: rel_path.clone(),
                    line,
                    rule_id: "rust/no-structural-type-fork",
                    message: format!(
                        "Struct '{struct_name}' duplicates the field shape of '{owner_name}' ({owner_file}:{owner_line}); share or import one owned struct instead of forking a parallel shape."
                    ),
                });
            } else {
                seen.insert(signature, (struct_name, rel_path.clone(), line));
            }
        }
    }
}

pub(super) fn check_constant_return_fields(
    workspace_root: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut candidates: BTreeMap<String, StructCandidate> = BTreeMap::new();
    for file_path in rs_files {
        let Some(ast) = parsed_files.get(file_path) else {
            continue;
        };
        let rel_path = relative_display(workspace_root, file_path);
        for item in &ast.items {
            if let Item::Struct(item_struct) = item {
                collect_struct_candidate(&rel_path, item_struct, &mut candidates);
            }
        }
    }
    if candidates.is_empty() {
        return;
    }
    let mut tracker = ConstantFieldTracker {
        current_impl_self: None,
        candidates: &mut candidates,
        mutated_fields: FxHashSet::default(),
    };
    for file_path in rs_files {
        if let Some(ast) = parsed_files.get(file_path) {
            tracker.visit_file(ast);
        }
    }
    let mutated_fields = tracker.mutated_fields;
    for (struct_name, candidate) in candidates {
        if candidate.skipped_due_to_rest || candidate.construction_sites < 2 {
            continue;
        }
        for (field_name, field_state) in candidate.fields {
            if !mutated_fields.contains(&field_name)
                && let FieldInitState::Constant(constant_repr) = field_state.init_state
            {
                diagnostics.push(RustDiagnostic {
                    file: candidate.file.clone(),
                    line: field_state.line,
                    rule_id: "rust/no-constant-return-field",
                    message: format!(
                        "Field '{field_name}' on struct '{struct_name}' is initialized to the same constant '{constant_repr}' across all {} construction sites and never mutated; delete the dead field or derive it at the boundary.",
                        candidate.construction_sites
                    ),
                });
            }
        }
    }
}

struct StructCandidate {
    file: String,
    construction_sites: usize,
    skipped_due_to_rest: bool,
    fields: BTreeMap<String, CandidateField>,
}

struct CandidateField {
    line: usize,
    init_state: FieldInitState,
}

enum FieldInitState {
    Unseen,
    Constant(String),
    Variable,
}

fn collect_struct_candidate(
    rel_path: &str,
    item_struct: &ItemStruct,
    candidates: &mut BTreeMap<String, StructCandidate>,
) {
    if has_deserialize_or_repr_c(&item_struct.attrs) {
        return;
    }
    let Fields::Named(named) = &item_struct.fields else {
        return;
    };
    let struct_name = item_struct.ident.to_string();
    if candidates.remove(&struct_name).is_some() {
        return;
    }
    let mut fields = BTreeMap::new();
    for field in &named.named {
        if let Some(ident) = &field.ident
            && is_candidate_scalar_or_option_type(&field.ty)
        {
            fields.insert(
                ident.to_string(),
                CandidateField {
                    line: ident.span().start().line.max(1),
                    init_state: FieldInitState::Unseen,
                },
            );
        }
    }
    if !fields.is_empty() {
        candidates.insert(
            struct_name,
            StructCandidate {
                file: rel_path.to_owned(),
                construction_sites: 0,
                skipped_due_to_rest: false,
                fields,
            },
        );
    }
}

fn has_deserialize_or_repr_c(attrs: &[Attribute]) -> bool {
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
                .is_some_and(|seg| seg.ident == "Deserialize" || seg.ident == "Default")
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

fn is_candidate_scalar_or_option_type(ty: &Type) -> bool {
    let Type::Path(tp) = ty else {
        return false;
    };
    tp.path.segments.last().is_some_and(|last| {
        matches!(
            last.ident.to_string().as_str(),
            "bool"
                | "Option"
                | "String"
                | "usize"
                | "u8"
                | "u16"
                | "u32"
                | "u64"
                | "isize"
                | "i8"
                | "i16"
                | "i32"
                | "i64"
                | "f32"
                | "f64"
        )
    })
}

struct ConstantFieldTracker<'a> {
    current_impl_self: Option<String>,
    candidates: &'a mut BTreeMap<String, StructCandidate>,
    mutated_fields: FxHashSet<String>,
}

impl<'ast> Visit<'ast> for ConstantFieldTracker<'_> {
    fn visit_item_impl(&mut self, node: &'ast ItemImpl) {
        let prev = self.current_impl_self.take();
        if let Type::Path(tp) = &*node.self_ty
            && let Some(last) = tp.path.segments.last()
        {
            self.current_impl_self = Some(last.ident.to_string());
        }
        visit::visit_item_impl(self, node);
        self.current_impl_self = prev;
    }

    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        let target_name = node.path.segments.last().map(|seg| seg.ident.to_string());
        let resolved_name = match target_name.as_deref() {
            Some("Self") => self.current_impl_self.clone(),
            Some(other) => Some(other.to_owned()),
            None => None,
        };
        if let Some(name) = resolved_name
            && let Some(candidate) = self.candidates.get_mut(&name)
        {
            record_struct_construction(candidate, node);
        }
        visit::visit_expr_struct(self, node);
    }

    fn visit_expr_assign(&mut self, node: &'ast ExprAssign) {
        if let Some(field_name) = extract_assigned_field_name(&node.left) {
            self.mutated_fields.insert(field_name);
        }
        visit::visit_expr_assign(self, node);
    }

    fn visit_expr_binary(&mut self, node: &'ast ExprBinary) {
        if is_compound_assign_op(&node.op)
            && let Some(field_name) = extract_assigned_field_name(&node.left)
        {
            self.mutated_fields.insert(field_name);
        }
        visit::visit_expr_binary(self, node);
    }

    fn visit_expr_reference(&mut self, node: &'ast ExprReference) {
        if node.mutability.is_some()
            && let Some(field_name) = extract_assigned_field_name(&node.expr)
        {
            self.mutated_fields.insert(field_name);
        }
        visit::visit_expr_reference(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if MUTATING_FIELD_METHODS
            .iter()
            .any(|name| node.method == *name)
            && let Some(field_name) = extract_assigned_field_name(&node.receiver)
        {
            self.mutated_fields.insert(field_name);
        }
        visit::visit_expr_method_call(self, node);
    }
}

fn record_struct_construction(candidate: &mut StructCandidate, node: &ExprStruct) {
    if node.rest.is_some() {
        candidate.skipped_due_to_rest = true;
        return;
    }
    candidate.construction_sites += 1;
    for field_val in &node.fields {
        let Member::Named(ident) = &field_val.member else {
            continue;
        };
        let Some(field_entry) = candidate.fields.get_mut(&ident.to_string()) else {
            continue;
        };
        let const_val = field_val
            .colon_token
            .and_then(|_| extract_constant_init_repr(&field_val.expr));
        field_entry.init_state = match (&field_entry.init_state, const_val) {
            (FieldInitState::Unseen, Some(val)) => FieldInitState::Constant(val),
            (FieldInitState::Constant(existing), Some(val)) if *existing == val => {
                FieldInitState::Constant(val)
            }
            _ => FieldInitState::Variable,
        };
    }
}

fn is_compound_assign_op(op: &BinOp) -> bool {
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

fn extract_assigned_field_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Field(ExprField {
            member: Member::Named(ident),
            ..
        }) => Some(ident.to_string()),
        Expr::Index(idx) => extract_assigned_field_name(&idx.expr),
        Expr::Paren(paren) => extract_assigned_field_name(&paren.expr),
        _ => None,
    }
}

fn extract_constant_init_repr(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Lit(ExprLit { lit, .. }) => match lit {
            Lit::Bool(b) => Some(b.value.to_string()),
            Lit::Int(i) => Some(i.base10_digits().to_owned()),
            Lit::Float(f) => Some(f.base10_digits().to_owned()),
            Lit::Str(s) => Some(format!("{:?}", s.value())),
            _ => None,
        },
        Expr::Path(ExprPath { path, .. }) => path
            .segments
            .last()
            .filter(|seg| seg.ident == "None")
            .map(|_| "None".to_owned()),
        Expr::MethodCall(call)
            if (call.method == "to_owned" || call.method == "to_string")
                && call.args.is_empty() =>
        {
            extract_constant_init_repr(&call.receiver)
        }
        Expr::Call(call) if call.args.is_empty() => {
            let Expr::Path(callee) = &*call.func else {
                return None;
            };
            let segs: Vec<&syn::Ident> = callee.path.segments.iter().map(|s| &s.ident).collect();
            (segs.len() >= 2 && *segs[segs.len() - 2] == "String" && *segs[segs.len() - 1] == "new")
                .then(|| "\"\"".to_owned())
        }
        _ => None,
    }
}

fn relative_display(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

fn struct_field_signature(item_struct: &ItemStruct) -> Option<Vec<(String, String)>> {
    let Fields::Named(named) = &item_struct.fields else {
        return None;
    };
    if named.named.len() < 3 {
        return None;
    }
    let mut signature = Vec::with_capacity(named.named.len());
    for field in &named.named {
        let ident = field.ident.as_ref()?;
        let norm_ty = normalize_syn_type(&field.ty)?;
        signature.push((ident.to_string(), norm_ty));
    }
    signature.sort_by(|a, b| a.0.cmp(&b.0));
    Some(signature)
}

fn normalize_angle_args(angle: &syn::AngleBracketedGenericArguments) -> Option<String> {
    let mut args = Vec::new();
    for arg in &angle.args {
        if let GenericArgument::Type(inner) = arg {
            args.push(normalize_syn_type(inner)?);
        }
    }
    Some(if args.is_empty() {
        String::new()
    } else {
        format!("<{}>", args.join(","))
    })
}

fn normalize_syn_type(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(tp) => {
            let last = tp.path.segments.last()?;
            let mut out = last.ident.to_string();
            if let PathArguments::AngleBracketed(angle) = &last.arguments {
                out.push_str(&normalize_angle_args(angle)?);
            }
            Some(out)
        }
        Type::Reference(tr) => {
            let prefix = if tr.mutability.is_some() {
                "&mut "
            } else {
                "&"
            };
            Some(format!("{prefix}{}", normalize_syn_type(&tr.elem)?))
        }
        Type::Slice(ts) => Some(format!("[{}]", normalize_syn_type(&ts.elem)?)),
        Type::Tuple(tt) => {
            let elems: Option<Vec<_>> = tt.elems.iter().map(normalize_syn_type).collect();
            Some(format!("({})", elems?.join(",")))
        }
        _ => None,
    }
}
