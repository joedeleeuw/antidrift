use super::RustDiagnostic;
use super::struct_index::{StructIndex, file_scope, type_path};
use super::syn_kernel::{extract_pat_ident, has_derive_or_repr, is_compound_assign_op};
use super::value_origin::peel_expr;
use super::workspace::relative_display;
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use syn::visit::{self, Visit};
use syn::{Expr, ExprLit, ExprPath, ExprStruct, FnArg, Lit, Member, Pat, Type};

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

pub(super) fn check_constant_return_fields(
    workspace_root: &Path,
    index: &StructIndex<'_>,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut candidates = BTreeMap::new();
    for (key, definition) in &index.definitions {
        if has_derive_or_repr(
            &definition.structure.attrs,
            &["Deserialize", "Serialize", "Default"],
        ) {
            continue;
        }
        let fields: BTreeMap<_, _> = definition
            .structure
            .fields
            .iter()
            .filter_map(|field| {
                let ident = field.ident.as_ref()?;
                is_candidate_scalar_or_option_type(&field.ty).then(|| {
                    (
                        ident.to_string(),
                        CandidateField {
                            line: ident.span().start().line.max(1),
                            init_state: FieldInitState::Unseen,
                        },
                    )
                })
            })
            .collect();
        if !fields.is_empty() {
            candidates.insert(
                key.clone(),
                StructCandidate {
                    file: relative_display(workspace_root, definition.file),
                    construction_sites: 0,
                    skipped_due_to_rest: false,
                    fields,
                },
            );
        }
    }
    let mut tracker = ConstantFieldTracker {
        index,
        scope: Vec::new(),
        current_impl: None,
        bindings: BTreeMap::new(),
        candidates: &mut candidates,
    };
    for file in rs_files {
        if let Some(ast) = parsed_files.get(file) {
            tracker.scope = file_scope(file);
            tracker.visit_file(ast);
        }
    }
    for (key, candidate) in candidates {
        if candidate.skipped_due_to_rest || candidate.construction_sites < 2 {
            continue;
        }
        for (field_name, field) in candidate.fields {
            if let FieldInitState::Constant(constant) = field.init_state {
                diagnostics.push(RustDiagnostic::error(
                    candidate.file.clone(),
                    field.line,
                    "rust/no-constant-return-field",
                    format!(
                        "Field '{field_name}' on struct '{}' is initialized to the same constant '{constant}' across all {} construction sites and never mutated; delete the dead field or derive it at the boundary.",
                        key.join("::"), candidate.construction_sites
                    ),
                ));
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

struct ConstantFieldTracker<'a> {
    index: &'a StructIndex<'a>,
    scope: Vec<String>,
    current_impl: Option<Vec<String>>,
    bindings: BTreeMap<String, Vec<String>>,
    candidates: &'a mut BTreeMap<Vec<String>, StructCandidate>,
}

impl ConstantFieldTracker<'_> {
    fn resolve_path(&self, path: &syn::Path) -> Option<Vec<String>> {
        if path.is_ident("Self") {
            self.current_impl.clone()
        } else {
            self.index.resolve(&self.scope, path)
        }
    }

    fn declared_owner(&self, ty: &Type) -> Option<Vec<String>> {
        let path = type_path(ty)?;
        Some(self.resolve_path(path).unwrap_or_else(|| {
            path.segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect()
        }))
    }

    fn expr_owner(&self, expr: &Expr) -> Option<Vec<String>> {
        match peel_expr(expr) {
            Expr::Path(path) if path.path.is_ident("self") => self.current_impl.clone(),
            Expr::Path(path) => self
                .bindings
                .get(&path.path.get_ident()?.to_string())
                .cloned(),
            Expr::Struct(structure) => self.resolve_path(&structure.path),
            Expr::Call(call) => {
                let Expr::Path(callee) = &*call.func else {
                    return None;
                };
                let mut path = callee.path.clone();
                path.segments.pop();
                path.segments.pop_punct();
                self.resolve_path(&path)
            }
            Expr::Field(field) => {
                let owner = self.expr_owner(&field.base)?;
                let declaration = self.index.definitions.get(&owner)?;
                let Member::Named(name) = &field.member else {
                    return None;
                };
                let field = declaration
                    .structure
                    .fields
                    .iter()
                    .find(|field| field.ident.as_ref() == Some(name))?;
                self.index
                    .resolve(&owner[..owner.len() - 1], type_path(&field.ty)?)
            }
            _ => None,
        }
    }

    fn record_mutation(&mut self, expr: &Expr) {
        let field = match peel_expr(expr) {
            Expr::Field(field) => field,
            Expr::Index(index) => {
                self.record_mutation(&index.expr);
                return;
            }
            _ => return,
        };
        let Member::Named(name) = &field.member else {
            return;
        };
        let field_name = name.to_string();
        if let Some(owner) = self.expr_owner(&field.base) {
            if let Some(candidate) = self.candidates.get_mut(&owner)
                && let Some(field) = candidate.fields.get_mut(&field_name)
            {
                field.init_state = FieldInitState::Variable;
            }
            return;
        }
        for (key, candidate) in &mut *self.candidates {
            if key[..key.len() - 1] == self.scope
                && let Some(field) = candidate.fields.get_mut(&field_name)
            {
                field.init_state = FieldInitState::Variable;
            }
        }
    }

    fn bind_pattern(&mut self, pat: &Pat, owner: Option<Vec<String>>) {
        if let Some((name, _)) = extract_pat_ident(pat) {
            if let Some(owner) = owner {
                self.bindings.insert(name, owner);
            } else {
                self.bindings.remove(&name);
            }
        }
    }

    fn enter_function(&mut self, signature: &syn::Signature) -> BTreeMap<String, Vec<String>> {
        let previous = std::mem::take(&mut self.bindings);
        for input in &signature.inputs {
            if let FnArg::Typed(typed) = input {
                let owner = self.declared_owner(&typed.ty);
                self.bind_pattern(&typed.pat, owner);
            }
        }
        previous
    }
}

impl<'ast> Visit<'ast> for ConstantFieldTracker<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.scope.push(node.ident.to_string());
        visit::visit_item_mod(self, node);
        self.scope.pop();
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let owner = type_path(&node.self_ty).and_then(|path| self.resolve_path(path));
        let previous = std::mem::replace(&mut self.current_impl, owner);
        visit::visit_item_impl(self, node);
        self.current_impl = previous;
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        let implementation = self.current_impl.take();
        let previous = self.enter_function(&node.sig);
        visit::visit_item_fn(self, node);
        self.bindings = previous;
        self.current_impl = implementation;
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        let previous = self.enter_function(&node.sig);
        visit::visit_impl_item_fn(self, node);
        self.bindings = previous;
    }

    fn visit_block(&mut self, node: &'ast syn::Block) {
        let previous = self.bindings.clone();
        visit::visit_block(self, node);
        self.bindings = previous;
    }

    fn visit_local(&mut self, node: &'ast syn::Local) {
        visit::visit_local(self, node);
        let owner = match &node.pat {
            Pat::Type(typed) => self.declared_owner(&typed.ty),
            _ => node
                .init
                .as_ref()
                .and_then(|init| self.expr_owner(&init.expr)),
        };
        self.bind_pattern(&node.pat, owner);
    }

    fn visit_expr_struct(&mut self, node: &'ast ExprStruct) {
        if let Some(owner) = self.resolve_path(&node.path)
            && let Some(candidate) = self.candidates.get_mut(&owner)
        {
            record_struct_construction(candidate, node);
        }
        visit::visit_expr_struct(self, node);
    }

    fn visit_expr_assign(&mut self, node: &'ast syn::ExprAssign) {
        self.record_mutation(&node.left);
        visit::visit_expr_assign(self, node);
    }

    fn visit_expr_binary(&mut self, node: &'ast syn::ExprBinary) {
        if is_compound_assign_op(&node.op) {
            self.record_mutation(&node.left);
        }
        visit::visit_expr_binary(self, node);
    }

    fn visit_expr_reference(&mut self, node: &'ast syn::ExprReference) {
        if node.mutability.is_some() {
            self.record_mutation(&node.expr);
        }
        visit::visit_expr_reference(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        let mutating = [
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
        if mutating.iter().any(|name| node.method == *name) {
            self.record_mutation(&node.receiver);
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
    for field in &node.fields {
        let Member::Named(ident) = &field.member else {
            continue;
        };
        let Some(entry) = candidate.fields.get_mut(&ident.to_string()) else {
            continue;
        };
        let constant = field
            .colon_token
            .and_then(|_| extract_constant_init_repr(&field.expr));
        entry.init_state = match (&entry.init_state, constant) {
            (FieldInitState::Unseen, Some(constant)) => FieldInitState::Constant(constant),
            (FieldInitState::Constant(existing), Some(constant)) if *existing == constant => {
                FieldInitState::Constant(constant)
            }
            _ => FieldInitState::Variable,
        };
    }
}
