use super::RustDiagnostic;
use super::value_origin::{
    Bindings, Origin, Representation, UNTYPED_VALUE_METHODS, has_value_evidence,
    is_string_key_probe, is_value_path, is_value_type, peel_expr, serde_representation,
};
use rustc_hash::FxHashSet;
use std::path::Path;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Expr, ExprCall, ExprMethodCall, FnArg, Item, Pat, Signature, Type};

pub(super) fn check_value_flow(
    rel_path: &str,
    path: &Path,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let boundary = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| ["rule_scope.rs", "batch.rs", "json_manifest.rs"].contains(&name));
    ValueFlow {
        rel_path,
        boundary,
        bindings: Bindings::default(),
        module_items: &ast.items,
        self_fields: FxHashSet::default(),
        diagnostics,
    }
    .visit_file(ast);
}

struct ValueFlow<'a, 'ast> {
    rel_path: &'a str,
    boundary: bool,
    bindings: Bindings,
    module_items: &'ast [Item],
    self_fields: FxHashSet<String>,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl ValueFlow<'_, '_> {
    fn origin(&self, expr: &Expr) -> Origin {
        let origin = match peel_expr(expr) {
            Expr::Path(path) if is_value_path(&path.path) => Origin::Untyped,
            Expr::Path(path) => path.path.get_ident().map_or(Origin::Unknown, |ident| {
                self.bindings.origin(&ident.to_string())
            }),
            Expr::Call(call) => {
                if let Some(representation) = serde_representation(call, true) {
                    return Origin::Serialized(representation);
                }
                if serde_representation(call, false).is_some()
                    || matches!(&*call.func, Expr::Path(path) if is_value_path(&path.path))
                {
                    return Origin::Untyped;
                }
                Origin::Unknown
            }
            Expr::Macro(mac)
                if mac
                    .mac
                    .path
                    .segments
                    .last()
                    .is_some_and(|seg| seg.ident == "json") =>
            {
                Origin::Untyped
            }
            Expr::Index(index) => self.origin(&index.expr),
            Expr::Field(field)
                if matches!(&*field.base, Expr::Path(path) if path.path.is_ident("self"))
                    && matches!(&field.member, syn::Member::Named(name) if self.self_fields.contains(&name.to_string())) =>
            {
                Origin::Untyped
            }
            Expr::MethodCall(call) => {
                if UNTYPED_VALUE_METHODS
                    .iter()
                    .any(|method| call.method == *method)
                {
                    return Origin::Untyped;
                }
                match self.origin(&call.receiver) {
                    Origin::Untyped | Origin::Serialized(Representation::Value) => Origin::Untyped,
                    _ => Origin::Unknown,
                }
            }
            _ => Origin::Unknown,
        };
        if matches!(origin, Origin::Unknown) && has_value_evidence(expr) {
            Origin::Untyped
        } else {
            origin
        }
    }

    fn enter_function(&mut self, signature: &Signature) -> Bindings {
        let previous = std::mem::take(&mut self.bindings);
        for input in &signature.inputs {
            let FnArg::Typed(typed) = input else {
                continue;
            };
            let origin = if is_value_type(&typed.ty) {
                Origin::Untyped
            } else {
                Origin::Typed
            };
            self.bindings.bind(&typed.pat, origin);
        }
        previous
    }

    fn probe_is_untyped(&self, expr: &Expr) -> bool {
        matches!(
            self.origin(expr),
            Origin::Untyped | Origin::Serialized(Representation::Value)
        ) || matches!(expr, Expr::Index(index) if !matches!(self.origin(&index.expr), Origin::Typed))
            || matches!(expr, Expr::MethodCall(call) if self.probe_is_untyped(&call.receiver))
    }
}

impl<'ast> Visit<'ast> for ValueFlow<'_, 'ast> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        let previous = self.module_items;
        if let Some((_, items)) = &node.content {
            self.module_items = items;
        }
        visit::visit_item_mod(self, node);
        self.module_items = previous;
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let previous = std::mem::take(&mut self.self_fields);
        for member in self.module_items {
            let Item::Struct(structure) = member else {
                continue;
            };
            if matches!(&*node.self_ty, Type::Path(ty) if ty.path.is_ident(&structure.ident)) {
                self.self_fields.extend(
                    structure
                        .fields
                        .iter()
                        .filter(|field| is_value_type(&field.ty))
                        .filter_map(|field| field.ident.as_ref().map(ToString::to_string)),
                );
            }
        }
        visit::visit_item_impl(self, node);
        self.self_fields = previous;
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        let previous = self.enter_function(&node.sig);
        let fields = std::mem::take(&mut self.self_fields);
        visit::visit_item_fn(self, node);
        self.bindings = previous;
        self.self_fields = fields;
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        let previous = self.enter_function(&node.sig);
        visit::visit_impl_item_fn(self, node);
        self.bindings = previous;
    }

    fn visit_trait_item_fn(&mut self, node: &'ast syn::TraitItemFn) {
        let previous = self.enter_function(&node.sig);
        visit::visit_trait_item_fn(self, node);
        self.bindings = previous;
    }

    fn visit_block(&mut self, node: &'ast syn::Block) {
        self.bindings.enter();
        visit::visit_block(self, node);
        self.bindings.leave();
    }

    fn visit_local(&mut self, node: &'ast syn::Local) {
        visit::visit_local(self, node);
        let origin = match &node.pat {
            Pat::Type(typed) if is_value_type(&typed.ty) => Origin::Untyped,
            Pat::Type(typed) if !matches!(&*typed.ty, Type::Infer(_)) => Origin::Typed,
            _ => node
                .init
                .as_ref()
                .map_or(Origin::Unknown, |init| self.origin(&init.expr)),
        };
        let origin = match node.init.as_ref().map(|init| self.origin(&init.expr)) {
            Some(Origin::Serialized(representation)) => Origin::Serialized(representation),
            _ => origin,
        };
        self.bindings.bind(&node.pat, origin);
    }

    fn visit_expr_assign(&mut self, node: &'ast syn::ExprAssign) {
        visit::visit_expr_assign(self, node);
        self.bindings.invalidate(&node.left);
    }

    fn visit_expr_binary(&mut self, node: &'ast syn::ExprBinary) {
        visit::visit_expr_binary(self, node);
        if super::syn_kernel::is_compound_assign_op(&node.op) {
            self.bindings.invalidate(&node.left);
        }
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        self.bindings.enter();
        for input in &node.inputs {
            let origin = match input {
                Pat::Type(typed) if is_value_type(&typed.ty) => Origin::Untyped,
                _ => Origin::Unknown,
            };
            self.bindings.bind(input, origin);
        }
        visit::visit_expr_closure(self, node);
        self.bindings.leave();
    }

    fn visit_expr_for_loop(&mut self, node: &'ast syn::ExprForLoop) {
        self.visit_expr(&node.expr);
        let origin = match self.origin(&node.expr) {
            Origin::Untyped | Origin::Serialized(Representation::Value) => Origin::Untyped,
            _ => Origin::Unknown,
        };
        self.bindings.enter();
        self.bindings.bind(&node.pat, origin);
        self.visit_block(&node.body);
        self.bindings.leave();
    }

    fn visit_arm(&mut self, node: &'ast syn::Arm) {
        self.bindings.enter();
        self.bindings.bind(&node.pat, Origin::Unknown);
        visit::visit_arm(self, node);
        self.bindings.leave();
    }

    fn visit_expr_if(&mut self, node: &'ast syn::ExprIf) {
        self.bindings.enter();
        self.visit_expr(&node.cond);
        self.visit_block(&node.then_branch);
        self.bindings.leave();
        if let Some((_, branch)) = &node.else_branch {
            self.visit_expr(branch);
        }
    }

    fn visit_expr_while(&mut self, node: &'ast syn::ExprWhile) {
        self.bindings.enter();
        visit::visit_expr_while(self, node);
        self.bindings.leave();
    }

    fn visit_expr_let(&mut self, node: &'ast syn::ExprLet) {
        self.visit_expr(&node.expr);
        let origin = self.origin(&node.expr);
        self.bindings.bind(&node.pat, origin);
    }

    fn visit_expr_reference(&mut self, node: &'ast syn::ExprReference) {
        visit::visit_expr_reference(self, node);
        if node.mutability.is_some() {
            self.bindings.invalidate(&node.expr);
        }
    }

    fn visit_expr_call(&mut self, node: &'ast ExprCall) {
        if let Some(decoded) = serde_representation(node, false)
            && let Some(arg) = node.args.first()
            && let Origin::Serialized(encoded) = self.origin(arg)
            && encoded == decoded
        {
            self.diagnostics.push(RustDiagnostic {
                file: self.rel_path.to_owned(),
                line: node.func.span().start().line.max(1),
                rule_id: "rust/no-value-roundtrip",
                message: "Do not serialize and deserialize the same value; construct or convert the target type directly.".to_owned(),
            });
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        let specific = UNTYPED_VALUE_METHODS
            .iter()
            .any(|name| node.method == *name);
        let string_probe = (node.method == "and_then" || node.method == "as_str")
            && is_string_key_probe(&node.receiver)
            && (self.probe_is_untyped(&node.receiver) || node.args.iter().any(has_value_evidence));
        if !self.boundary && (specific || string_probe) {
            self.diagnostics.push(RustDiagnostic {
                file: self.rel_path.to_owned(),
                line: node.method.span().start().line.max(1),
                rule_id: "rust/no-untyped-config-probe",
                message: format!("Untyped config probe '.{}()' outside boundary decoder; deserialize once into a typed struct at the boundary.", node.method),
            });
        }
        self.visit_expr(&node.receiver);
        for argument in &node.args {
            let Expr::Closure(closure) = argument else {
                self.visit_expr(argument);
                continue;
            };
            self.bindings.enter();
            let origin = match self.origin(&node.receiver) {
                Origin::Untyped | Origin::Serialized(Representation::Value) => Origin::Untyped,
                _ => Origin::Unknown,
            };
            for input in &closure.inputs {
                self.bindings.bind(input, origin);
            }
            self.visit_expr(&closure.body);
            self.bindings.leave();
        }
        if [
            "as_object_mut",
            "as_array_mut",
            "get_mut",
            "push",
            "push_str",
            "clear",
            "insert",
            "remove",
            "extend",
            "take",
        ]
        .iter()
        .any(|method| node.method == *method)
        {
            self.bindings.invalidate(&node.receiver);
        }
    }
}
