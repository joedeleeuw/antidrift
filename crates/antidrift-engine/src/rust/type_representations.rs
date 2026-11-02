use super::RustDiagnostic;
use super::syn_ast::path_ends_with;
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    BinOp, Expr, ExprBinary, ExprField, ExprLit, ExprMethodCall, GenericArgument, ItemStruct, Lit,
    Member, PathArguments, Type, TypePath,
};

const STRINGLY_VARIANT_FIELDS: &[&str] = &[
    "kind",
    "mode",
    "status",
    "variant",
    "category",
    "classification",
    "type",
    "state",
    "level",
    "severity",
];

pub(super) fn check_type_representations(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    TypeRepresentationVisitor {
        rel_path,
        diagnostics,
    }
    .visit_file(ast);
}

struct TypeRepresentationVisitor<'a> {
    rel_path: &'a str,
    diagnostics: &'a mut Vec<RustDiagnostic>,
}

impl TypeRepresentationVisitor<'_> {
    fn push(&mut self, span: Span, rule_id: &'static str, message: impl Into<String>) {
        self.diagnostics.push(RustDiagnostic::error(
            self.rel_path.to_owned(),
            span.start().line.max(1),
            rule_id,
            message.into(),
        ));
    }
}

impl<'ast> Visit<'ast> for TypeRepresentationVisitor<'_> {
    fn visit_type_path(&mut self, node: &'ast TypePath) {
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

    fn visit_type(&mut self, node: &'ast Type) {
        if let Type::Tuple(tuple) = node {
            let option_count = tuple
                .elems
                .iter()
                .filter(|elem| is_option_type(elem))
                .count();
            if option_count >= 2 {
                self.push(
                    tuple.paren_token.span.open(),
                    "rust/no-nullable-positional-tuple",
                    "Tuple type has 2 or more nullable (Option<_>) positional elements; use a named struct or enum so each optional slot is named.",
                );
            }
        }
        visit::visit_type(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast ItemStruct) {
        for field in &node.fields {
            let Some(ident) = &field.ident else {
                continue;
            };
            let raw_name = ident.to_string();
            let field_name = raw_name.strip_prefix("r#").unwrap_or(&raw_name);
            if STRINGLY_VARIANT_FIELDS.contains(&field_name) && is_string_or_str_type(&field.ty) {
                self.push(
                    ident.span(),
                    "rust/no-stringly-variant",
                    format!(
                        "Struct '{}' field '{raw_name}' uses a stringly discriminant; replace with a closed enum.",
                        node.ident
                    ),
                );
            }
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast ExprMethodCall) {
        if node.method == "as_str" && ident_to_string_call_span(&node.receiver).is_some() {
            self.push(
                node.method.span(),
                "rust/no-ident-to-string-compare",
                "Do not allocate '.to_string().as_str()' on 'syn::Ident'; compare 'ident == \"...\"' directly.",
            );
        }
        if node.method == "parse" && node.args.is_empty() && is_to_string_call(&node.receiver) {
            self.push(
                node.method.span(),
                "rust/no-value-roundtrip",
                "Do not round-trip a value through '.to_string().parse()'; convert or pass the typed value directly.",
            );
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_binary(&mut self, node: &'ast ExprBinary) {
        if matches!(node.op, BinOp::Eq(_) | BinOp::Ne(_)) {
            let span = if matches!(
                &*node.right,
                Expr::Lit(ExprLit {
                    lit: Lit::Str(_),
                    ..
                })
            ) {
                ident_to_string_call_span(&node.left)
            } else if matches!(
                &*node.left,
                Expr::Lit(ExprLit {
                    lit: Lit::Str(_),
                    ..
                })
            ) {
                ident_to_string_call_span(&node.right)
            } else {
                None
            };
            if let Some(span) = span {
                self.push(
                    span,
                    "rust/no-ident-to-string-compare",
                    "Do not allocate '.to_string()' on 'syn::Ident' to compare against a string literal; compare 'ident == \"...\"' directly.",
                );
            }
        }
        visit::visit_expr_binary(self, node);
    }
}

fn ident_to_string_call_span(expr: &Expr) -> Option<Span> {
    let Expr::MethodCall(call) = expr else {
        return None;
    };
    if call.method != "to_string" || !call.args.is_empty() {
        return None;
    };
    let Expr::Field(ExprField {
        member: Member::Named(field_ident),
        ..
    }) = &*call.receiver
    else {
        return None;
    };
    (field_ident == "ident" || field_ident == "method").then(|| call.method.span())
}

fn is_to_string_call(expr: &Expr) -> bool {
    matches!(expr, Expr::MethodCall(call) if call.method == "to_string" && call.args.is_empty())
}

fn is_string_or_str_type(ty: &Type) -> bool {
    match ty {
        Type::Path(type_path) => {
            path_ends_with(&type_path.path, &["String"])
                || path_ends_with(&type_path.path, &["str"])
                || is_cow_str_path(&type_path.path)
        }
        Type::Reference(type_ref) => is_string_or_str_type(&type_ref.elem),
        _ => false,
    }
}

fn is_cow_str_path(path: &syn::Path) -> bool {
    let Some(last) = path.segments.last() else {
        return false;
    };
    if last.ident != "Cow" {
        return false;
    }
    let PathArguments::AngleBracketed(angle) = &last.arguments else {
        return false;
    };
    angle.args.iter().any(|arg| {
        matches!(
            arg,
            GenericArgument::Type(Type::Path(inner)) if path_ends_with(&inner.path, &["str"])
        )
    })
}

fn is_option_type(ty: &Type) -> bool {
    let Type::Path(type_path) = ty else {
        return false;
    };
    type_path.qself.is_none()
        && type_path.path.segments.last().is_some_and(|seg| {
            seg.ident == "Option" && matches!(seg.arguments, PathArguments::AngleBracketed(_))
        })
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
