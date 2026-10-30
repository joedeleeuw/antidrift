use std::path::{Path, PathBuf};
use syn::{Attribute, Expr, ExprLit, Item, ItemMod, Lit, Meta};

pub(super) fn declared_modules(file: &Path, is_root: bool, ast: &syn::File) -> Vec<PathBuf> {
    let directory = file.parent().unwrap_or_else(|| Path::new("."));
    let search = if is_root {
        directory.to_path_buf()
    } else {
        module_search_dir(file)
    };
    let mut declared = Vec::new();
    collect_external_mods(&ast.items, directory, &search, &mut declared);
    declared
}

fn module_search_dir(file_path: &Path) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") {
        parent.to_path_buf()
    } else {
        let stem = file_path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        parent.join(stem)
    }
}

pub(super) fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn collect_external_mods(items: &[Item], file_dir: &Path, base_dir: &Path, out: &mut Vec<PathBuf>) {
    for item in items {
        let Item::Mod(item_mod) = item else {
            continue;
        };
        if let Some((_, inline_items)) = &item_mod.content {
            let inline_dir = if let Some(custom) = extract_path_attr(&item_mod.attrs) {
                normalize_lexical_path(&file_dir.join(custom))
            } else {
                base_dir.join(item_mod.ident.to_string())
            };
            collect_external_mods(inline_items, file_dir, &inline_dir, out);
            continue;
        }
        if let Some(resolved) = resolve_external_mod(item_mod, file_dir, base_dir) {
            out.push(resolved);
        }
    }
}

fn resolve_external_mod(item_mod: &ItemMod, file_dir: &Path, base_dir: &Path) -> Option<PathBuf> {
    if let Some(custom_path) = extract_path_attr(&item_mod.attrs) {
        for base in [file_dir, base_dir] {
            let candidate = normalize_lexical_path(&base.join(&custom_path));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let name = item_mod.ident.to_string();
    [
        base_dir.join(format!("{name}.rs")),
        base_dir.join(&name).join("mod.rs"),
        file_dir.join(format!("{name}.rs")),
        file_dir.join(name).join("mod.rs"),
    ]
    .into_iter()
    .map(|p| normalize_lexical_path(&p))
    .find(|p| p.is_file())
}

fn extract_path_attr(attrs: &[Attribute]) -> Option<String> {
    attrs.iter().find_map(|attr| {
        if !attr.path().is_ident("path") {
            return None;
        }
        let Meta::NameValue(nv) = &attr.meta else {
            return None;
        };
        let Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) = &nv.value
        else {
            return None;
        };
        Some(s.value())
    })
}
