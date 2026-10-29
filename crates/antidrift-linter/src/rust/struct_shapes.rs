use super::RustDiagnostic;
use super::struct_index::StructIndex;
use super::syn_kernel::has_derive_or_repr;
use super::workspace::relative_display;
use rustc_hash::FxHashMap;
use std::path::Path;
use syn::{Expr, Fields, GenericArgument, ItemStruct, PathArguments, Type};

type FieldSignature = Vec<(String, String)>;

pub(super) fn check_structural_type_forks(
    workspace_root: &Path,
    index: &StructIndex<'_>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut seen = FxHashMap::default();
    for definition in index.definitions.values() {
        let item_struct = definition.structure;
        let rel_path = relative_display(workspace_root, definition.file);
        check_redundant_owner_prefix(&rel_path, item_struct, diagnostics);
        let signature = match struct_field_signature(item_struct) {
            Ok(Some(signature)) => signature,
            Ok(None) => continue,
            Err(error) => {
                diagnostics.push(RustDiagnostic::error(
                    rel_path,
                    error.span().start().line.max(1),
                    "rust/syntax-error",
                    format!("Invalid struct attribute: {error}"),
                ));
                continue;
            }
        };
        let struct_name = item_struct.ident.to_string();
        let line = item_struct.ident.span().start().line.max(1);
        if let Some((owner_name, owner_file, owner_line)) = seen.get(&signature) {
            diagnostics.push(RustDiagnostic::error(
                rel_path,
                line,
                "rust/no-structural-type-fork",
                format!(
                    "Struct '{struct_name}' duplicates the field shape of '{owner_name}' ({owner_file}:{owner_line}); share or import one owned struct instead of forking a parallel shape."
                ),
            ));
        } else {
            seen.insert(signature, (struct_name, rel_path, line));
        }
    }
}

fn check_redundant_owner_prefix(
    rel_path: &str,
    item_struct: &ItemStruct,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    if has_derive_or_repr(&item_struct.attrs, &["Deserialize", "Serialize"]) {
        return;
    }
    let Fields::Named(named) = &item_struct.fields else {
        return;
    };
    if named.named.len() < 2 {
        return;
    }
    let struct_name = item_struct.ident.to_string();
    let Some(stem) = leading_compound_stem(&struct_name) else {
        return;
    };
    let prefix = format!("{stem}_");
    let all_prefixed = named.named.iter().all(|field| {
        field.ident.as_ref().is_some_and(|ident| {
            ident
                .to_string()
                .strip_prefix(&prefix)
                .is_some_and(|rest| !rest.is_empty())
        })
    });
    if all_prefixed {
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            item_struct.ident.span().start().line.max(1),
            "rust/no-redundant-owner-prefix",
            format!(
                "Struct '{struct_name}' prefixes all {} fields with '{prefix}'; drop the redundant owner prefix from field names.",
                named.named.len()
            ),
        ));
    }
}

fn leading_compound_stem(name: &str) -> Option<String> {
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_uppercase() {
        return None;
    }
    let mut stem = String::from(first.to_ascii_lowercase());
    for ch in chars {
        if ch.is_ascii_uppercase() {
            return (stem.len() >= 3).then_some(stem);
        }
        if !ch.is_ascii_alphanumeric() {
            return None;
        }
        stem.push(ch);
    }
    None
}

fn struct_field_signature(item_struct: &ItemStruct) -> syn::Result<Option<FieldSignature>> {
    for attribute in item_struct
        .attrs
        .iter()
        .filter(|attr| attr.path().is_ident("repr"))
    {
        let representations = attribute.parse_args_with(
            syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
        )?;
        if representations
            .iter()
            .any(|meta| meta.path().is_ident("C") || meta.path().is_ident("transparent"))
        {
            return Ok(None);
        }
    }
    let Fields::Named(named) = &item_struct.fields else {
        return Ok(None);
    };
    if named.named.len() < 3 {
        return Ok(None);
    }
    let mut signature = Vec::with_capacity(named.named.len());
    for field in &named.named {
        let Some(ident) = field.ident.as_ref() else {
            return Ok(None);
        };
        let Some(norm_ty) = normalize_syn_type(&field.ty) else {
            return Ok(None);
        };
        let mut wire_names = [ident.to_string(), ident.to_string()];
        for attribute in field
            .attrs
            .iter()
            .filter(|attr| attr.path().is_ident("serde"))
        {
            let attributes = attribute.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            )?;
            for attribute in attributes
                .iter()
                .filter(|meta| meta.path().is_ident("rename"))
            {
                record_wire_names(attribute, &mut wire_names)?;
            }
        }
        signature.push((ident.to_string(), format!("{norm_ty}:{wire_names:?}")));
    }
    signature.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Some(signature))
}

fn record_wire_names(attribute: &syn::Meta, names: &mut [String; 2]) -> syn::Result<()> {
    match attribute {
        syn::Meta::NameValue(rename) => {
            let name = wire_name_literal(&rename.value)?;
            *names = [name.clone(), name];
        }
        syn::Meta::List(list) => {
            let renames = list.parse_args_with(
                syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
            )?;
            for rename in renames {
                let syn::Meta::NameValue(rename) = rename else {
                    return Err(syn::Error::new_spanned(
                        rename,
                        "expected serialize or deserialize = a string literal",
                    ));
                };
                let direction = match rename.path.get_ident().map(ToString::to_string).as_deref() {
                    Some("serialize") => 0,
                    Some("deserialize") => 1,
                    _ => {
                        return Err(syn::Error::new_spanned(
                            rename.path,
                            "expected serialize or deserialize",
                        ));
                    }
                };
                names[direction] = wire_name_literal(&rename.value)?;
            }
        }
        syn::Meta::Path(_) => {
            return Err(syn::Error::new_spanned(
                attribute,
                "expected serde rename = a string literal",
            ));
        }
    }
    Ok(())
}

fn wire_name_literal(expr: &Expr) -> syn::Result<String> {
    if let Expr::Lit(literal) = expr
        && let syn::Lit::Str(name) = &literal.lit
    {
        return Ok(name.value());
    }
    Err(syn::Error::new_spanned(
        expr,
        "serde rename must be a string literal",
    ))
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
