use super::value_origin::is_value_type;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use syn::{ImplItem, Item, ItemStruct, ReturnType, Type};

pub(super) struct StructDefinition<'a> {
    pub(super) file: &'a Path,
    pub(super) structure: &'a ItemStruct,
}

const MAX_REEXPORT_HOPS: usize = 8;

pub(super) enum PathResolution {
    Imported(Vec<String>),
    Lexical(Vec<String>),
}

#[derive(Default)]
pub(super) struct ImportTable {
    imports: BTreeMap<Vec<String>, Vec<String>>,
    glob_scopes: FxHashSet<Vec<String>>,
}

impl ImportTable {
    pub(super) fn collect(&mut self, scope: &[String], tree: &syn::UseTree, prefix: &[String]) {
        match tree {
            syn::UseTree::Path(path) => {
                let mut child = prefix.to_vec();
                child.push(path.ident.to_string());
                self.collect(scope, &path.tree, &child);
            }
            syn::UseTree::Group(group) => {
                for child in &group.items {
                    self.collect(scope, child, prefix);
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
            syn::UseTree::Glob(_) => {
                self.glob_scopes.insert(scope.to_vec());
            }
        }
    }

    pub(super) fn resolve_path(&self, scope: &[String], segments: &[String]) -> Vec<String> {
        match self.resolution(scope, segments) {
            PathResolution::Imported(path) | PathResolution::Lexical(path) => path,
        }
    }

    pub(super) fn resolution(&self, scope: &[String], segments: &[String]) -> PathResolution {
        let mut candidate = qualify(scope, segments);
        let mut imported = false;
        for _ in 0..MAX_REEXPORT_HOPS {
            let Some(resolved) = self.follow_import(&candidate) else {
                break;
            };
            if resolved == candidate {
                break;
            }
            candidate = resolved;
            imported = true;
        }
        if imported {
            PathResolution::Imported(candidate)
        } else {
            PathResolution::Lexical(candidate)
        }
    }

    fn follow_import(&self, candidate: &[String]) -> Option<Vec<String>> {
        (1..=candidate.len()).rev().find_map(|prefix_len| {
            let imported = self.imports.get(&candidate[..prefix_len])?;
            let mut resolved = qualify(&candidate[..prefix_len - 1], imported);
            resolved.extend_from_slice(&candidate[prefix_len..]);
            Some(resolved)
        })
    }

    pub(super) fn scope_has_glob(&self, scope: &[String]) -> bool {
        self.glob_scopes.contains(scope)
    }
}

pub(super) struct StructIndex<'a> {
    pub(super) definitions: BTreeMap<Vec<String>, StructDefinition<'a>>,
    enum_payloads: FxHashMap<String, FxHashSet<(Vec<String>, usize)>>,
    imports: ImportTable,
    private_modules: BTreeSet<Vec<String>>,
    reexports: FxHashSet<Vec<String>>,
    untyped_functions: FxHashSet<Vec<String>>,
    untyped_methods: FxHashSet<String>,
}

impl<'a> StructIndex<'a> {
    pub(super) fn new(files: &'a [PathBuf], parsed: &'a FxHashMap<PathBuf, syn::File>) -> Self {
        let mut index = Self {
            definitions: BTreeMap::new(),
            enum_payloads: FxHashMap::default(),
            imports: ImportTable::default(),
            private_modules: BTreeSet::new(),
            reexports: FxHashSet::default(),
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
                Item::Enum(item_enum) => self.collect_enum_payloads(scope, item_enum),
                Item::Fn(item_fn) if return_type_is_untyped(&item_fn.sig.output) => {
                    let mut key = scope.to_vec();
                    key.push(item_fn.sig.ident.to_string());
                    self.untyped_functions.insert(key);
                }
                Item::Impl(item_impl) => self.collect_impl(scope, item_impl),
                Item::Mod(item_mod) => self.collect_module(file, scope, item_mod),
                Item::Use(import) => self.collect_use(scope, import),
                _ => {}
            }
        }
    }

    fn collect_enum_payloads(&mut self, scope: &[String], item_enum: &syn::ItemEnum) {
        let mut key = scope.to_vec();
        key.push(item_enum.ident.to_string());
        for (variant_index, variant) in item_enum.variants.iter().enumerate() {
            let mut payloads = Vec::new();
            for field in &variant.fields {
                type_path_idents(&field.ty, &mut payloads);
            }
            for payload in payloads {
                self.enum_payloads
                    .entry(payload)
                    .or_default()
                    .insert((key.clone(), variant_index));
            }
        }
    }

    pub(super) fn variants_of_one_enum(&self, first: &str, second: &str) -> bool {
        match (
            self.enum_payloads.get(first),
            self.enum_payloads.get(second),
        ) {
            (Some(owners), Some(others)) => owners.iter().any(|(owner, variant)| {
                others
                    .iter()
                    .any(|(other, other_variant)| other == owner && other_variant != variant)
            }),
            _ => false,
        }
    }

    fn collect_module(&mut self, file: &'a Path, scope: &[String], item_mod: &'a syn::ItemMod) {
        let mut child = scope.to_vec();
        child.push(item_mod.ident.to_string());
        if !matches!(item_mod.vis, syn::Visibility::Public(_)) {
            self.private_modules.insert(child.clone());
        }
        if let Some((_, items)) = &item_mod.content {
            self.collect(file, &child, items);
        }
    }

    fn collect_use(&mut self, scope: &[String], import: &syn::ItemUse) {
        self.imports.collect(scope, &import.tree, &[]);
        if !matches!(import.vis, syn::Visibility::Public(_)) {
            return;
        }
        let mut leaves = Vec::new();
        collect_use_leaves(&import.tree, &[], &mut leaves);
        for leaf in leaves {
            self.reexports.insert(qualify(scope, &leaf));
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
        let resolved = self.imports.resolve_path(scope, &segments);
        if resolved != candidate {
            return self.definitions.contains_key(&resolved).then_some(resolved);
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
        let resolved = self.imports.resolve_path(scope, &segments);
        if resolved != candidate {
            return self.untyped_functions.contains(&resolved);
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

    pub(super) fn is_externally_visible(&self, key: &[String], vis: &syn::Visibility) -> bool {
        if !matches!(vis, syn::Visibility::Public(_)) {
            return false;
        }
        if self.reexports.contains(key) {
            return true;
        }
        (1..key.len()).all(|depth| !self.private_modules.contains(&key[..depth]))
    }
}

fn collect_use_leaves(tree: &syn::UseTree, prefix: &[String], out: &mut Vec<Vec<String>>) {
    match tree {
        syn::UseTree::Path(path) => {
            let mut child = prefix.to_vec();
            child.push(path.ident.to_string());
            collect_use_leaves(&path.tree, &child, out);
        }
        syn::UseTree::Group(group) => {
            for child in &group.items {
                collect_use_leaves(child, prefix, out);
            }
        }
        syn::UseTree::Name(name) => {
            let mut target = prefix.to_vec();
            target.push(name.ident.to_string());
            out.push(target);
        }
        syn::UseTree::Rename(rename) => {
            let mut target = prefix.to_vec();
            target.push(rename.ident.to_string());
            out.push(target);
        }
        syn::UseTree::Glob(_) => {}
    }
}

fn return_type_is_untyped(output: &ReturnType) -> bool {
    match output {
        ReturnType::Default => false,
        ReturnType::Type(_, ty) => is_value_type(ty),
    }
}

pub(super) fn qualify(scope: &[String], segments: &[String]) -> Vec<String> {
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

fn type_path_idents(ty: &Type, out: &mut Vec<String>) {
    match ty {
        Type::Path(path) => {
            for inner in path.path.segments.iter().flat_map(generic_type_arguments) {
                type_path_idents(inner, out);
            }
            if let Some(last) = path.path.segments.last() {
                out.push(last.ident.to_string());
            }
        }
        Type::Reference(reference) => type_path_idents(&reference.elem, out),
        Type::Paren(paren) => type_path_idents(&paren.elem, out),
        Type::Array(array) => type_path_idents(&array.elem, out),
        Type::Slice(slice) => type_path_idents(&slice.elem, out),
        Type::Tuple(tuple) => {
            for elem in &tuple.elems {
                type_path_idents(elem, out);
            }
        }
        _ => {}
    }
}

fn generic_type_arguments(segment: &syn::PathSegment) -> Vec<&Type> {
    let syn::PathArguments::AngleBracketed(args) = &segment.arguments else {
        return Vec::new();
    };
    args.args
        .iter()
        .filter_map(|arg| match arg {
            syn::GenericArgument::Type(inner) => Some(inner),
            _ => None,
        })
        .collect()
}
