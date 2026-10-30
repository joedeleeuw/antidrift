use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile, SymbolFlags};
use tsrs_core::P;

const OMIT_TYPE: &str = "Omit";
const MODIFIER_UTILITIES: [&str; 3] = ["Partial", "Readonly", "Required"];

pub enum ReferenceKind {
    Omit {
        source: Option<P<Node>>,
        removed: Vec<String>,
    },
    Passthrough(Option<P<Node>>),
    Alias {
        name: String,
        target: P<Node>,
    },
    Opaque,
}

pub struct LocalTypeAliases {
    pub sf: P<SourceFile>,
}

impl LocalTypeAliases {
    #[must_use]
    pub const fn collect(sf: P<SourceFile>) -> Self {
        Self { sf }
    }

    #[must_use]
    pub fn classify_reference(
        &self,
        reference_node: P<Node>,
        open: &FxHashSet<String>,
    ) -> ReferenceKind {
        let reference = reference_node.as_type_reference_node();
        let name = type_reference_name(reference.type_name());
        let arguments = reference_node.type_arguments();
        if name.as_deref() == Some(OMIT_TYPE) {
            return ReferenceKind::Omit {
                source: arguments.first().copied(),
                removed: literal_keys_of(arguments.get(1).copied()),
            };
        }
        if name
            .as_deref()
            .is_some_and(|name| MODIFIER_UTILITIES.contains(&name))
        {
            return ReferenceKind::Passthrough(arguments.first().copied());
        }
        if let Some(alias_name) = name.filter(|name| !open.contains(name))
            && let Some(target) =
                resolve_lexical_type_alias(self.sf, reference_node, alias_name.as_str())
        {
            return ReferenceKind::Alias {
                name: alias_name,
                target,
            };
        }
        ReferenceKind::Opaque
    }

    pub fn within_alias<T>(
        &self,
        name: &str,
        open: &mut FxHashSet<String>,
        visit: impl FnOnce(&Self, &mut FxHashSet<String>) -> T,
    ) -> T {
        open.insert(name.to_owned());
        let visited = visit(self, open);
        open.remove(name);
        visited
    }
}

fn scope_declares_type_parameter(scope: P<Node>, target_name: &str) -> bool {
    let mut found = false;
    scope.for_each_child(&mut |child| {
        let hit = child.kind() == Kind::TypeParameter
            && child
                .name()
                .is_some_and(|n| ast::is_identifier(n) && n.as_identifier().text() == target_name);
        found |= hit;
        hit
    });
    found
}

fn resolve_lexical_type_alias(
    sf: P<SourceFile>,
    reference_node: P<Node>,
    target_name: &str,
) -> Option<P<Node>> {
    let root = sf.as_node();
    let mut current = reference_node.parent();
    while let Some(scope) = current {
        if scope_declares_type_parameter(scope, target_name) {
            return None;
        }
        if let Some(locals) = scope.locals()
            && let Some(sym) = locals.get().get(target_name)
        {
            let shadowed_flags = SymbolFlags::Alias
                | SymbolFlags::TypeParameter
                | SymbolFlags::Interface
                | SymbolFlags::Class
                | SymbolFlags::Enum;
            if sym.flags.get().intersects(shadowed_flags) {
                return None;
            }
            let mut decls = sym
                .declarations()
                .iter()
                .copied()
                .filter(|&decl| decl.kind() == Kind::TypeAliasDeclaration);
            let decl = decls.next().filter(|_| decls.next().is_none())?;
            let alias_decl = decl.as_type_alias_declaration();
            return alias_decl
                .type_parameters()
                .is_none_or(|params| params.nodes().is_empty())
                .then(|| alias_decl.type_())
                .flatten();
        }
        if scope == root {
            break;
        }
        current = scope.parent();
    }
    None
}

#[must_use]
pub fn type_reference_name(type_name: P<Node>) -> Option<String> {
    match type_name.kind() {
        Kind::Identifier => Some(type_name.as_identifier().text().to_owned()),
        Kind::QualifiedName => {
            let q = type_name.as_qualified_name();
            let right = q.right();
            ast::is_identifier(right)
                .then(|| type_reference_name(q.left()))
                .flatten()
                .map(|left| format!("{left}.{}", right.as_identifier().text()))
        }
        _ => None,
    }
}

#[must_use]
pub fn property_key_name(key: P<Node>) -> Option<String> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text().to_owned()),
        Kind::StringLiteral => Some(key.as_string_literal().text().to_owned()),
        _ => None,
    }
}

#[must_use]
pub fn literal_keys_of(type_node: Option<P<Node>>) -> Vec<String> {
    let Some(node) = type_node else {
        return Vec::new();
    };
    match node.kind() {
        Kind::LiteralType => {
            let lit = node.as_literal_type_node().literal();
            if lit.kind() == Kind::StringLiteral {
                vec![lit.as_string_literal().text().to_owned()]
            } else {
                Vec::new()
            }
        }
        Kind::UnionType => node
            .as_union_type_node()
            .types()
            .nodes()
            .iter()
            .flat_map(|&member| literal_keys_of(Some(member)))
            .collect(),
        _ => Vec::new(),
    }
}

#[must_use]
pub fn is_empty_union_branch(member: P<Node>) -> bool {
    matches!(
        member.kind(),
        Kind::NeverKeyword | Kind::NullKeyword | Kind::UndefinedKeyword | Kind::VoidKeyword
    ) || (member.kind() == Kind::LiteralType
        && member.as_literal_type_node().literal().kind() == Kind::NullKeyword)
}

#[must_use]
pub fn as_reference(type_node: Option<P<Node>>) -> Option<P<Node>> {
    let node = type_node?;
    match node.kind() {
        Kind::ParenthesizedType => as_reference(Some(node.as_parenthesized_type_node().type_())),
        Kind::TypeReference => Some(node),
        _ => None,
    }
}

#[must_use]
pub fn intersect_all(key_sets: &[Vec<String>]) -> Vec<String> {
    let Some((first, rest)) = key_sets.split_first() else {
        return Vec::new();
    };
    let mut seen = FxHashSet::default();
    first
        .iter()
        .filter(|key| seen.insert(key.as_str()) && rest.iter().all(|keys| keys.contains(key)))
        .cloned()
        .collect()
}
