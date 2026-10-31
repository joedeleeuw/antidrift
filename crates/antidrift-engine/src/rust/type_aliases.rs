use super::struct_index::type_path;
use rustc_hash::FxHashMap;

const MAX_ALIAS_HOPS: usize = 8;

pub(super) struct TypeAliases {
    targets: FxHashMap<String, String>,
}

impl TypeAliases {
    pub(super) fn collect(items: &[syn::Item]) -> Self {
        let mut targets = FxHashMap::default();
        collect_type_aliases(items, &mut targets);
        Self { targets }
    }

    pub(super) fn canonical(&self, name: &str) -> String {
        let mut current = name.to_owned();
        for _ in 0..MAX_ALIAS_HOPS {
            let Some(next) = self.targets.get(&current) else {
                break;
            };
            current.clone_from(next);
        }
        current
    }
}

fn collect_type_aliases(items: &[syn::Item], aliases: &mut FxHashMap<String, String>) {
    for item in items {
        match item {
            syn::Item::Type(alias) => {
                if let Some(target) = last_type_segment(&alias.ty) {
                    aliases.insert(alias.ident.to_string(), target);
                }
            }
            syn::Item::Use(import) => collect_use_renames(&import.tree, aliases),
            syn::Item::Mod(syn::ItemMod {
                content: Some((_, nested)),
                ..
            }) => collect_type_aliases(nested, aliases),
            _ => {}
        }
    }
}

fn collect_use_renames(tree: &syn::UseTree, aliases: &mut FxHashMap<String, String>) {
    match tree {
        syn::UseTree::Path(path) => collect_use_renames(&path.tree, aliases),
        syn::UseTree::Group(group) => {
            for entry in &group.items {
                collect_use_renames(entry, aliases);
            }
        }
        syn::UseTree::Rename(rename) => {
            aliases.insert(rename.rename.to_string(), rename.ident.to_string());
        }
        syn::UseTree::Name(_) | syn::UseTree::Glob(_) => {}
    }
}

pub(super) fn last_type_segment(ty: &syn::Type) -> Option<String> {
    type_path(ty)?
        .segments
        .last()
        .map(|segment| segment.ident.to_string())
}
