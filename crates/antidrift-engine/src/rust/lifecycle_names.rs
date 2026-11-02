use antidrift_kernel::declared_names::{is_compat_name, name_key, plain_sibling_key};
use proc_macro2::Span;
use rustc_hash::FxHashMap;
use std::path::PathBuf;
use syn::visit::{self, Visit};

#[derive(Default)]
pub(super) struct CrateNames {
    declared: FxHashMap<String, String>,
}

impl CrateNames {
    pub(super) fn collect(files: &[PathBuf], parsed: &FxHashMap<PathBuf, syn::File>) -> Self {
        let mut names = Self::default();
        for ast in files.iter().filter_map(|file| parsed.get(file)) {
            names.visit_file(ast);
        }
        names
    }

    fn declare(&mut self, name: &str) {
        self.declared
            .entry(name_key(name))
            .or_insert_with(|| name.to_owned());
    }

    fn sibling(&self, key: &str) -> Option<&str> {
        self.declared.get(key).map(String::as_str)
    }
}

impl<'ast> Visit<'ast> for CrateNames {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.declare(&node.sig.ident.to_string());
        visit::visit_item_fn(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        self.declare(&node.ident.to_string());
        for ident in node.fields.iter().filter_map(|field| field.ident.as_ref()) {
            self.declare(&ident.to_string());
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        self.declare(&node.ident.to_string());
        for variant in &node.variants {
            self.declare(&variant.ident.to_string());
        }
        visit::visit_item_enum(self, node);
    }

    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        for leaf in use_tree_leaves(&node.tree) {
            self.declare(&leaf);
        }
        visit::visit_item_use(self, node);
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        self.declare(&node.sig.ident.to_string());
        visit::visit_impl_item_fn(self, node);
    }

    fn visit_item_type(&mut self, node: &'ast syn::ItemType) {
        self.declare(&node.ident.to_string());
        visit::visit_item_type(self, node);
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        self.declare(&node.ident.to_string());
        visit::visit_item_const(self, node);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        self.declare(&node.ident.to_string());
        visit::visit_item_static(self, node);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        self.declare(&node.ident.to_string());
        visit::visit_item_trait(self, node);
    }

    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.declare(&node.ident.to_string());
        visit::visit_item_mod(self, node);
    }
}

pub(super) struct NameLedger<'a> {
    crate_names: &'a CrateNames,
    pending_names: Vec<(Span, String, Option<String>)>,
}

impl<'a> NameLedger<'a> {
    pub(super) fn new(crate_names: &'a CrateNames) -> Self {
        Self {
            crate_names,
            pending_names: Vec::new(),
        }
    }

    pub(super) fn note_compat(&mut self, name: &str, span: Span) -> bool {
        if !is_compat_name(name) {
            return false;
        }
        self.pending_names
            .push((span, name.to_owned(), plain_sibling_key(name)));
        true
    }

    pub(super) fn take_compat_reports(&mut self) -> Vec<(Span, String)> {
        std::mem::take(&mut self.pending_names)
            .into_iter()
            .map(|(span, name, sibling_key)| {
                let message = match sibling_key
                    .as_deref()
                    .and_then(|key| self.crate_names.sibling(key))
                {
                    Some(sibling) => format!(
                        "'{name}' uses compatibility naming while '{sibling}' is also declared; delete the old path instead of keeping or naming it."
                    ),
                    None => format!(
                        "'{name}' uses compatibility naming; delete the old path or name the item after its domain concept."
                    ),
                };
                (span, message)
            })
            .collect()
    }
}

pub(super) fn use_tree_leaves(tree: &syn::UseTree) -> Vec<String> {
    let mut leaves = Vec::new();
    collect_leaves(tree, &mut leaves);
    leaves
}

fn collect_leaves(tree: &syn::UseTree, leaves: &mut Vec<String>) {
    match tree {
        syn::UseTree::Path(path) => collect_leaves(&path.tree, leaves),
        syn::UseTree::Group(group) => {
            for item in &group.items {
                collect_leaves(item, leaves);
            }
        }
        syn::UseTree::Name(name) => leaves.push(name.ident.to_string()),
        syn::UseTree::Rename(rename) => leaves.push(rename.rename.to_string()),
        syn::UseTree::Glob(_) => {}
    }
}
