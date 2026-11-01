use std::cell::RefCell;
use std::thread::LocalKey;

use rustc_hash::FxHashMap;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_compiler::Program;
use tsrs_core::P;

use crate::file_role;
use crate::program_fact::{ProgramFact, ProgramFactSlot};

#[must_use]
pub fn name_key(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

pub const COMPAT_TOKENS: &[&str] = &["deprecated", "deprecate", "legacy", "nolonger", "compat"];

#[must_use]
pub fn is_compat_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.contains("legacy")
        || lower.contains("deprecated")
        || lower.contains("nolonger")
        || lower.contains("no_longer")
    {
        return true;
    }
    let mut search_from = 0usize;
    while let Some(offset) = lower[search_from..].find("compat") {
        let abs = search_from + offset;
        if !lower[abs..].starts_with("compatib") {
            return true;
        }
        search_from = abs + 6;
    }
    false
}

#[must_use]
pub fn plain_sibling_key(name: &str) -> Option<String> {
    let key = name_key(name);
    let (start, token) = COMPAT_TOKENS
        .iter()
        .filter_map(|token| key.find(token).map(|start| (start, *token)))
        .min_by_key(|(start, token)| (*start, std::cmp::Reverse(token.len())))?;
    let sibling = format!("{}{}", &key[..start], &key[start + token.len()..]);
    (!sibling.is_empty()).then_some(sibling)
}

const DECLARATION_KINDS: &[Kind] = &[
    Kind::FunctionDeclaration,
    Kind::MethodDeclaration,
    Kind::MethodSignature,
    Kind::ClassDeclaration,
    Kind::InterfaceDeclaration,
    Kind::TypeAliasDeclaration,
    Kind::EnumDeclaration,
    Kind::EnumMember,
    Kind::VariableDeclaration,
    Kind::PropertyDeclaration,
    Kind::PropertySignature,
    Kind::GetAccessor,
    Kind::SetAccessor,
    Kind::ImportSpecifier,
    Kind::ImportClause,
    Kind::NamespaceImport,
    Kind::ModuleDeclaration,
];

#[derive(Default)]
pub struct DeclaredNameIndex {
    keys: FxHashMap<String, &'static str>,
}

thread_local! {
    static INDEX_SLOT: ProgramFactSlot<DeclaredNameIndex> = const { RefCell::new(None) };
}

impl ProgramFact for DeclaredNameIndex {
    fn slot() -> &'static LocalKey<ProgramFactSlot<Self>> {
        &INDEX_SLOT
    }

    fn build(program: &Program) -> Self {
        let mut index = Self::default();
        for &sf in program.get_source_files() {
            if file_role::is_declaration_file(sf.file_name())
                || program.is_source_file_from_external_library(sf)
            {
                continue;
            }
            index.walk(sf.as_node());
        }
        index
    }
}

impl DeclaredNameIndex {
    #[must_use]
    pub fn declared_with_key(&self, key: &str) -> Option<&'static str> {
        self.keys.get(key).copied()
    }

    fn walk(&mut self, node: P<Node>) {
        if DECLARATION_KINDS.contains(&node.kind())
            && let Some(name) = node.name()
            && ast::is_identifier(name)
        {
            let text = name.as_identifier().text();
            self.keys.entry(name_key(text)).or_insert(text);
        }
        node.for_each_child(&mut |child| {
            self.walk(child);
            false
        });
    }
}
