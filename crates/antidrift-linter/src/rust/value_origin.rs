use super::syn_kernel::path_ends_with;
use rustc_hash::FxHashMap;
use syn::visit::{self, Visit};
use syn::{Expr, ExprCall, Pat, Type};

pub(super) const UNTYPED_VALUE_METHODS: &[&str] = &[
    "as_u64",
    "as_i64",
    "as_f64",
    "as_bool",
    "as_array",
    "as_object",
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Representation {
    Text,
    Bytes,
    Value,
}

#[derive(Clone, Copy, Default)]
pub(super) enum Origin {
    #[default]
    Unknown,
    Typed,
    Untyped,
    Serialized(Representation),
}

impl Origin {
    fn after_mutation(self) -> Self {
        match self {
            Self::Untyped | Self::Serialized(Representation::Value) => Self::Untyped,
            Self::Typed => Self::Typed,
            _ => Self::Unknown,
        }
    }
}

pub(super) struct Bindings {
    scopes: Vec<FxHashMap<String, Origin>>,
}

impl Default for Bindings {
    fn default() -> Self {
        Self {
            scopes: vec![FxHashMap::default()],
        }
    }
}

impl Bindings {
    pub(super) fn enter(&mut self) {
        self.scopes.push(FxHashMap::default());
    }

    pub(super) fn leave(&mut self) {
        self.scopes.pop();
    }

    pub(super) fn bind(&mut self, pat: &Pat, origin: Origin) {
        struct Binder<'a> {
            scope: &'a mut FxHashMap<String, Origin>,
            origin: Origin,
        }
        impl<'ast> Visit<'ast> for Binder<'_> {
            fn visit_pat_ident(&mut self, node: &'ast syn::PatIdent) {
                self.scope.insert(node.ident.to_string(), self.origin);
                visit::visit_pat_ident(self, node);
            }
        }
        if let Some(scope) = self.scopes.last_mut() {
            Binder { scope, origin }.visit_pat(pat);
        }
    }

    pub(super) fn invalidate(&mut self, expr: &Expr) {
        match peel_expr(expr) {
            Expr::Path(path) => {
                let Some(ident) = path.path.get_ident() else {
                    return;
                };
                if let Some(origin) = self
                    .scopes
                    .iter_mut()
                    .rev()
                    .find_map(|scope| scope.get_mut(&ident.to_string()))
                {
                    *origin = origin.after_mutation();
                }
            }
            Expr::Tuple(tuple) => {
                for element in &tuple.elems {
                    self.invalidate(element);
                }
            }
            Expr::Index(index) => self.invalidate(&index.expr),
            Expr::Field(field) => self.invalidate(&field.base),
            Expr::MethodCall(call) => self.invalidate(&call.receiver),
            _ => {}
        }
    }

    pub(super) fn origin(&self, name: &str) -> Origin {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name))
            .copied()
            .unwrap_or_default()
    }
}

pub(super) fn peel_expr(expr: &Expr) -> &Expr {
    match expr {
        Expr::Reference(reference) => peel_expr(&reference.expr),
        Expr::Paren(paren) => peel_expr(&paren.expr),
        Expr::Group(group) => peel_expr(&group.expr),
        Expr::Try(tried) => peel_expr(&tried.expr),
        Expr::MethodCall(call)
            if ((call.method == "unwrap"
                || call.method == "as_str"
                || call.method == "as_bytes"
                || call.method == "as_slice"
                || call.method == "clone")
                && call.args.is_empty())
                || (call.method == "expect" && call.args.len() == 1) =>
        {
            peel_expr(&call.receiver)
        }
        inner => inner,
    }
}

pub(super) fn serde_representation(call: &ExprCall, encode: bool) -> Option<Representation> {
    let Expr::Path(callee) = &*call.func else {
        return None;
    };
    let operation = &callee.path.segments.last()?.ident;
    let qualified = callee.path.segments.iter().any(|seg| {
        ["serde_json", "toml", "serde_yaml", "yaml_serde"]
            .iter()
            .any(|name| seg.ident == *name)
    });
    if !qualified {
        return None;
    }
    let operations: &[(&[&str], Representation)] = if encode {
        &[
            (&["to_string", "to_string_pretty"], Representation::Text),
            (&["to_vec", "to_vec_pretty"], Representation::Bytes),
            (&["to_value"], Representation::Value),
        ]
    } else {
        &[
            (&["from_str"], Representation::Text),
            (&["from_slice"], Representation::Bytes),
            (&["from_value"], Representation::Value),
        ]
    };
    operations
        .iter()
        .find(|(names, _)| names.iter().any(|name| operation == *name))
        .map(|(_, representation)| *representation)
}

pub(super) fn is_value_type(ty: &Type) -> bool {
    struct ValueTypeVisitor(bool);
    impl<'ast> Visit<'ast> for ValueTypeVisitor {
        fn visit_type_path(&mut self, node: &'ast syn::TypePath) {
            self.0 |= is_value_path(&node.path);
            visit::visit_type_path(self, node);
        }
    }
    let mut visitor = ValueTypeVisitor(false);
    visitor.visit_type(ty);
    visitor.0
}

pub(super) fn is_value_path(path: &syn::Path) -> bool {
    path.segments.iter().any(|segment| {
        ["Value", "serde_json", "serde_yaml", "yaml_serde", "toml"]
            .iter()
            .any(|name| segment.ident == *name)
    })
}

pub(super) fn has_value_evidence(expr: &Expr) -> bool {
    struct EvidenceVisitor(bool);
    impl<'ast> Visit<'ast> for EvidenceVisitor {
        fn visit_path(&mut self, node: &'ast syn::Path) {
            self.0 |= is_value_path(node)
                || ["from_str", "from_slice", "from_value", "json"]
                    .iter()
                    .any(|name| path_ends_with(node, &[name]));
            visit::visit_path(self, node);
        }

        fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
            self.0 |= UNTYPED_VALUE_METHODS
                .iter()
                .any(|name| node.method == *name);
            visit::visit_expr_method_call(self, node);
        }
    }
    let mut visitor = EvidenceVisitor(false);
    visitor.visit_expr(expr);
    visitor.0
}

pub(super) fn is_string_key_probe(expr: &Expr) -> bool {
    let key = match expr {
        Expr::MethodCall(call) if call.method == "get" && call.args.len() == 1 => &call.args[0],
        Expr::Index(index) => &*index.index,
        _ => return false,
    };
    matches!(key, Expr::Lit(literal) if matches!(literal.lit, syn::Lit::Str(_)))
}
