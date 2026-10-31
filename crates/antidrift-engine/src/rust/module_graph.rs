use super::RustDiagnostic;
use super::workspace::relative_display;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use syn::ext::IdentExt;
use syn::{Attribute, Expr, ExprLit, Item, ItemMod, Lit, Meta};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ModuleCode {
    Shipped,
    Test,
}

pub(super) struct DeclaredModule {
    pub(super) file: PathBuf,
    pub(super) code: ModuleCode,
}

pub(super) fn declared_modules(file: &Path, is_root: bool, ast: &syn::File) -> Vec<DeclaredModule> {
    let directory = file.parent().unwrap_or_else(|| Path::new("."));
    let search = if is_root {
        directory.to_path_buf()
    } else {
        module_search_dir(file)
    };
    let mut declared = Vec::new();
    collect_external_mods(
        &ast.items,
        directory,
        &search,
        ModuleCode::Shipped,
        &mut declared,
    );
    let macro_names = module_names_in_item_macros(&ast.items);
    if !macro_names.is_empty() {
        collect_macro_declared_files(&search, &macro_names, &mut declared);
    }
    declared
}

fn module_names_in_item_macros(items: &[Item]) -> FxHashSet<String> {
    let mut names = FxHashSet::default();
    for item in items {
        let Item::Macro(item_macro) = item else {
            continue;
        };
        if item_macro.mac.path.is_ident("macro_rules") {
            continue;
        }
        collect_token_idents(item_macro.mac.tokens.clone(), &mut names);
    }
    names
}

fn collect_token_idents(tokens: proc_macro2::TokenStream, out: &mut FxHashSet<String>) {
    for tree in tokens {
        match tree {
            proc_macro2::TokenTree::Ident(ident) => {
                out.insert(ident.to_string());
            }
            proc_macro2::TokenTree::Literal(literal) => {
                let text = literal.to_string();
                if let Some(inner) = text
                    .strip_prefix('"')
                    .and_then(|rest| rest.strip_suffix('"'))
                {
                    out.insert(inner.to_owned());
                }
            }
            proc_macro2::TokenTree::Group(group) => collect_token_idents(group.stream(), out),
            proc_macro2::TokenTree::Punct(_) => {}
        }
    }
}

fn collect_macro_declared_files(
    search: &Path,
    macro_names: &FxHashSet<String>,
    out: &mut Vec<DeclaredModule>,
) {
    let Ok(entries) = std::fs::read_dir(search) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let module_file = if path.extension().is_some_and(|ext| ext == "rs") {
            path.clone()
        } else if path.is_dir() && path.join("mod.rs").is_file() {
            path.join("mod.rs")
        } else {
            continue;
        };
        let named = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| macro_names.contains(stem))
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| macro_names.contains(name));
        if !named {
            continue;
        }
        out.push(DeclaredModule {
            file: normalize_lexical_path(&module_file),
            code: ModuleCode::Shipped,
        });
    }
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

fn collect_external_mods(
    items: &[Item],
    file_dir: &Path,
    base_dir: &Path,
    code: ModuleCode,
    out: &mut Vec<DeclaredModule>,
) {
    for item in items {
        let Item::Mod(item_mod) = item else {
            continue;
        };
        let item_code = if item_mod.attrs.iter().any(is_cfg_test_attribute) {
            ModuleCode::Test
        } else {
            code
        };
        if let Some((_, inline_items)) = &item_mod.content {
            let inline_dir = if let Some(custom) = extract_path_attr(&item_mod.attrs) {
                normalize_lexical_path(&file_dir.join(custom))
            } else {
                base_dir.join(item_mod.ident.unraw().to_string())
            };
            collect_external_mods(inline_items, file_dir, &inline_dir, item_code, out);
            continue;
        }
        if let Some(resolved) = resolve_external_mod(item_mod, file_dir, base_dir) {
            out.push(DeclaredModule {
                file: resolved,
                code: item_code,
            });
        }
    }
}

fn is_cfg_test_attribute(attr: &Attribute) -> bool {
    attr.path().is_ident("cfg") && super::syn_kernel::is_banned_test_attribute(attr)
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
    let name = item_mod.ident.unraw().to_string();
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

pub(super) fn check_orphan_modules(
    workspace_root: &Path,
    src_dir: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    mut roots: Vec<PathBuf>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    for root_name in ["lib.rs", "main.rs"] {
        let candidate = src_dir.join(root_name);
        if parsed_files.contains_key(&candidate) {
            roots.push(candidate);
        }
    }
    for file_path in rs_files {
        if let Ok(rel) = file_path.strip_prefix(src_dir)
            && rel.starts_with("bin")
        {
            roots.push(file_path.clone());
        }
    }
    if roots.is_empty() {
        return;
    }

    let mut reachable: FxHashSet<PathBuf> = FxHashSet::default();
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    let target_roots: FxHashSet<_> = roots.iter().cloned().collect();
    for root in roots {
        if reachable.insert(root.clone()) {
            queue.push_back(root);
        }
    }

    while let Some(current) = queue.pop_front() {
        let Some(ast) = parsed_files.get(&current) else {
            continue;
        };
        for declared in declared_modules(&current, target_roots.contains(&current), ast) {
            if reachable.insert(declared.file.clone()) {
                queue.push_back(declared.file);
            }
        }
    }

    for file_path in rs_files {
        if !reachable.contains(file_path) {
            let rel_path = relative_display(workspace_root, file_path);
            diagnostics.push(RustDiagnostic::error(
                rel_path,
                1,
                "rust/no-orphan-module",
                "Rust source file is not reachable from any Cargo target root (including manifest target paths); wire `mod` or delete the orphan file.".to_owned(),
            ));
        }
    }
}
