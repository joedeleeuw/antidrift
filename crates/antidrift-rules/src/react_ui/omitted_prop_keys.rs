use antidrift_kernel::tsrs_kernel::node_text;
use antidrift_kernel::type_syntax::{
    LocalTypeAliases, ReferenceKind, as_reference, intersect_all, is_empty_union_branch,
    property_key_name, type_reference_name,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

struct Supplier {
    source: String,
    removed: FxHashSet<String>,
}

fn type_signature(aliases: &LocalTypeAliases, type_node: Option<P<Node>>) -> String {
    let Some(type_node) = type_node else {
        return "?".to_owned();
    };
    match type_node.kind() {
        Kind::ParenthesizedType => type_signature(
            aliases,
            Some(type_node.as_parenthesized_type_node().type_()),
        ),
        Kind::TypeReference => {
            let reference = type_node.as_type_reference_node();
            let name = type_reference_name(reference.type_name()).unwrap_or_else(|| "?".to_owned());
            let args = type_node.type_arguments();
            if args.is_empty() {
                name
            } else {
                let rendered: Vec<String> = args
                    .iter()
                    .map(|&arg| type_signature(aliases, Some(arg)))
                    .collect();
                format!("{name}<{}>", rendered.join(","))
            }
        }
        Kind::LiteralType => {
            let lit = type_node.as_literal_type_node().literal();
            match lit.kind() {
                Kind::StringLiteral => serde_json::to_string(lit.as_string_literal().text())
                    .unwrap_or_else(|_| "null".to_owned()),
                Kind::NumericLiteral => lit.text().to_owned(),
                Kind::TrueKeyword => "true".to_owned(),
                Kind::FalseKeyword => "false".to_owned(),
                _ => "null".to_owned(),
            }
        }
        Kind::TypeLiteral => {
            let mut names: Vec<String> = type_node
                .as_type_literal_node()
                .members()
                .nodes()
                .iter()
                .map(|&member| match member.kind() {
                    Kind::PropertySignature => {
                        property_key_name(member.as_property_signature_declaration().name())
                    }
                    Kind::MethodSignature => {
                        property_key_name(member.as_method_signature_declaration().name())
                    }
                    _ => None,
                })
                .map(|name| name.unwrap_or_else(|| "?".to_owned()))
                .collect();
            names.sort();
            format!("{{{}}}", names.join(","))
        }
        Kind::UnionType | Kind::IntersectionType => {
            let (types, sep) = if type_node.kind() == Kind::UnionType {
                (type_node.as_union_type_node().types().nodes(), "|")
            } else {
                (type_node.as_intersection_type_node().types().nodes(), "&")
            };
            let rendered: Vec<String> = types
                .iter()
                .map(|&m| type_signature(aliases, Some(m)))
                .collect();
            format!("({})", rendered.join(sep))
        }
        _ => node_text(aliases.sf, type_node).to_owned(),
    }
}

fn suppliers_of(
    aliases: &LocalTypeAliases,
    type_node: Option<P<Node>>,
    open: &mut FxHashSet<String>,
) -> Vec<Supplier> {
    let Some(reference_node) = as_reference(type_node) else {
        return Vec::new();
    };
    match aliases.classify_reference(reference_node, open) {
        ReferenceKind::Omit { source, removed } => {
            let removed_set: FxHashSet<String> = removed.into_iter().collect();
            let mut suppliers = vec![Supplier {
                source: type_signature(aliases, source),
                removed: removed_set.clone(),
            }];
            suppliers.extend(
                suppliers_of(aliases, source, open)
                    .into_iter()
                    .map(|supplier| Supplier {
                        source: supplier.source,
                        removed: supplier.removed.union(&removed_set).cloned().collect(),
                    }),
            );
            suppliers
        }
        ReferenceKind::Passthrough(inner) => suppliers_of(aliases, inner, open),
        ReferenceKind::Alias { name, target } => {
            aliases.within_alias(&name, open, |aliases, open| {
                suppliers_of(aliases, Some(target), open)
            })
        }
        ReferenceKind::Opaque => vec![Supplier {
            source: type_signature(aliases, type_node),
            removed: FxHashSet::default(),
        }],
    }
}

pub(super) fn omitted_keys_of(
    aliases: &LocalTypeAliases,
    type_node: Option<P<Node>>,
    open: &mut FxHashSet<String>,
) -> Vec<String> {
    let Some(type_node) = type_node else {
        return Vec::new();
    };
    match type_node.kind() {
        Kind::ParenthesizedType => omitted_keys_of(
            aliases,
            Some(type_node.as_parenthesized_type_node().type_()),
            open,
        ),
        Kind::IntersectionType => {
            let members = type_node.as_intersection_type_node().types().nodes();
            let analysed: Vec<(Vec<String>, Vec<Supplier>)> = members
                .iter()
                .map(|&member| {
                    (
                        omitted_keys_of(aliases, Some(member), open),
                        suppliers_of(aliases, Some(member), open),
                    )
                })
                .collect();
            let resupplied = |index: usize, key: &str| is_resupplied(&analysed, index, key);
            analysed
                .iter()
                .enumerate()
                .flat_map(|(index, (keys, _))| {
                    keys.iter()
                        .filter(move |key| !resupplied(index, key))
                        .cloned()
                })
                .collect()
        }
        Kind::UnionType => {
            let key_sets: Vec<Vec<String>> = type_node
                .as_union_type_node()
                .types()
                .nodes()
                .iter()
                .copied()
                .filter(|&member| !is_empty_union_branch(member))
                .map(|member| omitted_keys_of(aliases, Some(member), open))
                .collect();
            intersect_all(&key_sets)
        }
        Kind::TypeReference => match aliases.classify_reference(type_node, open) {
            ReferenceKind::Omit {
                source,
                mut removed,
            } => {
                removed.extend(omitted_keys_of(aliases, source, open));
                removed
            }
            ReferenceKind::Passthrough(inner) => omitted_keys_of(aliases, inner, open),
            ReferenceKind::Alias { name, target } => {
                aliases.within_alias(&name, open, |aliases, open| {
                    omitted_keys_of(aliases, Some(target), open)
                })
            }
            ReferenceKind::Opaque => Vec::new(),
        },
        _ => Vec::new(),
    }
}

pub(super) fn reintroduced_keys_of(
    aliases: &LocalTypeAliases,
    type_node: Option<P<Node>>,
    open: &mut FxHashSet<String>,
) -> Vec<String> {
    let Some(type_node) = type_node else {
        return Vec::new();
    };
    match type_node.kind() {
        Kind::ParenthesizedType => reintroduced_keys_of(
            aliases,
            Some(type_node.as_parenthesized_type_node().type_()),
            open,
        ),
        Kind::IntersectionType | Kind::UnionType => {
            let members = if type_node.kind() == Kind::IntersectionType {
                type_node.as_intersection_type_node().types().nodes()
            } else {
                type_node.as_union_type_node().types().nodes()
            };
            members
                .iter()
                .flat_map(|&member| reintroduced_keys_of(aliases, Some(member), open))
                .collect()
        }
        Kind::TypeLiteral => type_node
            .as_type_literal_node()
            .members()
            .nodes()
            .iter()
            .filter_map(|&member| {
                if member.kind() != Kind::PropertySignature {
                    return None;
                }
                let key = member.as_property_signature_declaration().name();
                (key.kind() != Kind::ComputedPropertyName)
                    .then(|| property_key_name(key))
                    .flatten()
            })
            .collect(),
        Kind::TypeReference => match aliases.classify_reference(type_node, open) {
            ReferenceKind::Omit { source, removed } => reintroduced_keys_of(aliases, source, open)
                .into_iter()
                .filter(|key| !removed.contains(key))
                .collect(),
            ReferenceKind::Passthrough(inner) => reintroduced_keys_of(aliases, inner, open),
            ReferenceKind::Alias { name, target } => {
                aliases.within_alias(&name, open, |aliases, open| {
                    reintroduced_keys_of(aliases, Some(target), open)
                })
            }
            ReferenceKind::Opaque => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn is_resupplied(analysed: &[(Vec<String>, Vec<Supplier>)], index: usize, key: &str) -> bool {
    let own_sources: Vec<&str> = analysed[index]
        .1
        .iter()
        .filter(|own| own.removed.contains(key))
        .map(|own| own.source.as_str())
        .collect();
    analysed
        .iter()
        .enumerate()
        .filter(|(sibling_index, _)| *sibling_index != index)
        .flat_map(|(_, (_, suppliers))| suppliers)
        .any(|supplier| {
            !supplier.removed.contains(key) && own_sources.contains(&supplier.source.as_str())
        })
}
