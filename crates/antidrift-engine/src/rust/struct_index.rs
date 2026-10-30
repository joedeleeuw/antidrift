use super::value_origin::is_value_type;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use syn::{ImplItem, Item, ItemStruct, ReturnType, Type};

pub(super) struct StructDefinition<'a> {
    pub(super) file: &'a Path,
    pub(super) structure: &'a ItemStruct,
}

pub(super) struct StructIndex<'a> {
    pub(super) definitions: BTreeMap<Vec<String>, StructDefinition<'a>>,
    imports: BTreeMap<Vec<String>, Vec<String>>,
    untyped_functions: FxHashSet<Vec<String>>,
    untyped_methods: FxHashSet<String>,
}

impl<'a> StructIndex<'a> {
    pub(super) fn new(files: &'a [PathBuf], parsed: &'a FxHashMap<PathBuf, syn::File>) -> Self {
        let mut index = Self {
            definitions: BTreeMap::new(),
            imports: BTreeMap::new(),
            untyped_functions: FxHashSet::default(),
            untyped_methods: FxHashSet::default(),
        };
        for file in files {
            if let Some(ast) = parsed.get(file) {
                index.collect(file, &file_scope(file), &ast.items);
            }
        }
        index
    }

    fn collect(&mut self, file: &'a Path, scope: &[String], items: &'a [Item]) {
        for item in items {
            match item {
                Item::Struct(structure) => {
                    let mut key = scope.to_vec();
                    key.push(structure.ident.to_string());
                    self.definitions
                        .insert(key, StructDefinition { file, structure });
                }
                Item::Fn(item_fn) if return_type_is_untyped(&item_fn.sig.output) => {
                    let mut key = scope.to_vec();
                    key.push(item_fn.sig.ident.to_string());
                    self.untyped_functions.insert(key);
                }
                Item::Impl(item_impl) => self.collect_impl(scope, item_impl),
                Item::Mod(syn::ItemMod {
                    ident,
                    content: Some((_, items)),
                    ..
                }) => {
                    let mut child = scope.to_vec();
                    child.push(ident.to_string());
                    self.collect(file, &child, items);
                }
                Item::Use(import) => self.collect_import(scope, &import.tree, &[]),
                _ => {}
            }
        }
    }

    fn collect_impl(&mut self, scope: &[String], item_impl: &syn::ItemImpl) {
        let owner_ident = type_path(&item_impl.self_ty)
            .and_then(|p| p.segments.last())
            .map(|seg| seg.ident.to_string());
        for impl_item in &item_impl.items {
            let ImplItem::Fn(method) = impl_item else {
                continue;
            };
            if !return_type_is_untyped(&method.sig.output) {
                continue;
            }
            let method_name = method.sig.ident.to_string();
            self.untyped_methods.insert(method_name.clone());
            if let Some(ref owner) = owner_ident {
                let mut key = scope.to_vec();
                key.push(owner.clone());
                key.push(method_name);
                self.untyped_functions.insert(key);
            }
        }
    }

    fn collect_import(&mut self, scope: &[String], tree: &syn::UseTree, prefix: &[String]) {
        match tree {
            syn::UseTree::Path(path) => {
                let mut child = prefix.to_vec();
                child.push(path.ident.to_string());
                self.collect_import(scope, &path.tree, &child);
            }
            syn::UseTree::Group(group) => {
                for child in &group.items {
                    self.collect_import(scope, child, prefix);
                }
            }
            syn::UseTree::Name(name) => {
                let mut target = prefix.to_vec();
                target.push(name.ident.to_string());
                let mut alias = scope.to_vec();
                alias.push(name.ident.to_string());
                self.imports.insert(alias, target);
            }
            syn::UseTree::Rename(rename) => {
                let mut target = prefix.to_vec();
                target.push(rename.ident.to_string());
                let mut alias = scope.to_vec();
                alias.push(rename.rename.to_string());
                self.imports.insert(alias, target);
            }
            syn::UseTree::Glob(_) => {}
        }
    }

    pub(super) fn resolve(&self, scope: &[String], path: &syn::Path) -> Option<Vec<String>> {
        let segments: Vec<_> = path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect();
        let candidate = qualify(scope, &segments);
        if self.definitions.contains_key(&candidate) {
            return Some(candidate);
        }
        for prefix_len in (1..=candidate.len()).rev() {
            if let Some(imported) = self.imports.get(&candidate[..prefix_len]) {
                let mut resolved = qualify(&candidate[..prefix_len - 1], imported);
                resolved.extend_from_slice(&candidate[prefix_len..]);
                return self.definitions.contains_key(&resolved).then_some(resolved);
            }
        }
        if segments.len() == 1 {
            let mut matches = self
                .definitions
                .keys()
                .filter(|key| key.last() == segments.last());
            let first = matches.next()?;
            if matches.next().is_none() {
                return Some(first.clone());
            }
        }
        None
    }

    pub(super) fn resolves_to_untyped_fn(&self, scope: &[String], path: &syn::Path) -> bool {
        let segments: Vec<_> = path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect();
        let candidate = qualify(scope, &segments);
        if self.untyped_functions.contains(&candidate) {
            return true;
        }
        for prefix_len in (1..=candidate.len()).rev() {
            if let Some(imported) = self.imports.get(&candidate[..prefix_len]) {
                let mut resolved = qualify(&candidate[..prefix_len - 1], imported);
                resolved.extend_from_slice(&candidate[prefix_len..]);
                return self.untyped_functions.contains(&resolved);
            }
        }
        if segments.len() == 1 {
            return self
                .untyped_functions
                .iter()
                .any(|key| key.last() == segments.last());
        }
        false
    }

    pub(super) fn is_untyped_method(&self, method_name: &str) -> bool {
        self.untyped_methods.contains(method_name)
    }
}

fn return_type_is_untyped(output: &ReturnType) -> bool {
    match output {
        ReturnType::Default => false,
        ReturnType::Type(_, ty) => is_value_type(ty),
    }
}

fn qualify(scope: &[String], segments: &[String]) -> Vec<String> {
    let mut qualified = scope.to_vec();
    for (position, segment) in segments.iter().enumerate() {
        match segment.as_str() {
            "crate" if position == 0 => qualified.clear(),
            "self" if position == 0 => {}
            "super" => {
                qualified.pop();
            }
            _ => qualified.push(segment.clone()),
        }
    }
    qualified
}

pub(super) fn file_scope(file: &Path) -> Vec<String> {
    let components: Vec<_> = file
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    let start = components
        .iter()
        .rposition(|component| component == "src")
        .map_or(0, |position| position + 1);
    let mut scope = components[start..components.len().saturating_sub(1)].to_vec();
    if let Some(stem) = file.file_stem().and_then(|stem| stem.to_str())
        && !matches!(stem, "lib" | "main" | "mod")
    {
        scope.push(stem.to_owned());
    }
    scope
}

pub(super) fn type_path(ty: &Type) -> Option<&syn::Path> {
    match ty {
        Type::Path(path) => Some(&path.path),
        Type::Reference(reference) => type_path(&reference.elem),
        Type::Paren(paren) => type_path(&paren.elem),
        Type::Group(group) => type_path(&group.elem),
        _ => None,
    }
}
