use rustc_hash::FxHashSet;
use tsrs_ast::{
    self as ast, Kind, MappedTypeNode, Node, SourceFile, Symbol, SymbolFlags, TypeReferenceNode,
};
use tsrs_checker::{Checker, LiteralValue, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{
    get_call_signatures, get_construct_signatures, is_intrinsic_type, is_object_type,
    is_type_flag_set, is_union_type, union_type_parts,
};

use crate::provenance;
use crate::registries::NON_BAG_TYPE_NAMES;

pub fn same_type(checker: &mut Checker, left: P<Type>, right: P<Type>) -> bool {
    checker.is_type_assignable_to(left, right) && checker.is_type_assignable_to(right, left)
}

pub fn same_type_ignoring_nullish(checker: &mut Checker, left: P<Type>, right: P<Type>) -> bool {
    let left_non_null = checker.get_non_nullable_type(left);
    let right_non_null = checker.get_non_nullable_type(right);
    same_type(checker, left_non_null, right_non_null)
}

#[must_use]
pub fn non_nullish_type_parts(typ: P<Type>) -> Vec<P<Type>> {
    union_type_parts(typ)
        .into_iter()
        .filter(|&part| {
            !is_type_flag_set(
                part,
                TypeFlags::Undefined | TypeFlags::Null | TypeFlags::Void,
            )
        })
        .collect()
}

#[must_use]
pub fn is_specific_type(typ: P<Type>) -> bool {
    !is_type_flag_set(typ, TypeFlags::AnyOrUnknown)
}

#[must_use]
pub fn is_closed_key_domain_type(key_type: P<Type>) -> bool {
    let open_flags = TypeFlags::Any
        | TypeFlags::Unknown
        | TypeFlags::Never
        | TypeFlags::String
        | TypeFlags::Number
        | TypeFlags::ESSymbol;
    if is_type_flag_set(key_type, open_flags) {
        return false;
    }
    if is_union_type(key_type) {
        let members = key_type.types();
        if members.is_empty() {
            return false;
        }
        if members
            .iter()
            .any(|&member| is_type_flag_set(member, open_flags))
        {
            return false;
        }
    }
    true
}

#[must_use]
pub fn unwrap_transparent_type_node(type_node: P<Node>) -> P<Node> {
    let mut current = type_node;
    loop {
        match current.kind() {
            Kind::ParenthesizedType => {
                current = current.as_parenthesized_type_node().type_();
            }
            Kind::TypeOperator => {
                let op = current.as_type_operator_node();
                if op.operator() == Kind::ReadonlyKeyword {
                    current = op.type_();
                } else {
                    return current;
                }
            }
            Kind::TypeReference => {
                let type_ref = current.as_type_reference_node();
                if ast::is_identifier(type_ref.type_name())
                    && type_ref.type_name().as_identifier().text() == "Readonly"
                    && let Some(args) = type_ref.type_arguments()
                    && args.nodes().len() == 1
                {
                    current = args.nodes()[0];
                } else {
                    return current;
                }
            }
            _ => return current,
        }
    }
}

fn classify_closed_mapped_type(
    checker: &mut Checker,
    mapped: &MappedTypeNode,
) -> Option<&'static str> {
    if mapped.question_token().is_some() {
        return None;
    }
    let tp_node = mapped.type_parameter();
    let constraint = tp_node.as_type_parameter_declaration().constraint()?;
    let constraint_type = checker.get_type_from_type_node(constraint);
    is_closed_key_domain_type(constraint_type).then_some("mapped type")
}

fn classify_closed_type_reference(
    checker: &mut Checker,
    type_ref: &TypeReferenceNode,
    visited: &mut FxHashSet<P<Symbol>>,
) -> Option<&'static str> {
    if ast::is_identifier(type_ref.type_name())
        && type_ref.type_name().as_identifier().text() == "Record"
        && let Some(args) = type_ref.type_arguments()
        && args.nodes().len() == 2
    {
        let key_type = checker.get_type_from_type_node(args.nodes()[0]);
        return is_closed_key_domain_type(key_type).then_some("Record<K, V>");
    }
    let sym = provenance::symbol_at_node(checker, type_ref.type_name())?;
    if !visited.insert(sym) {
        return None;
    }
    for decl in provenance::symbol_declarations(checker, Some(sym)) {
        if decl.kind() == Kind::TypeAliasDeclaration
            && let Some(alias_type) = decl.as_type_alias_declaration().type_()
            && let Some(matched) =
                classify_closed_case_table_with_visited(checker, alias_type, visited)
        {
            return Some(matched);
        }
    }
    None
}

fn classify_closed_case_table_with_visited(
    checker: &mut Checker,
    type_node: P<Node>,
    visited: &mut FxHashSet<P<Symbol>>,
) -> Option<&'static str> {
    let current = unwrap_transparent_type_node(type_node);
    match current.kind() {
        Kind::MappedType => classify_closed_mapped_type(checker, current.as_mapped_type_node()),
        Kind::TypeReference => {
            classify_closed_type_reference(checker, current.as_type_reference_node(), visited)
        }
        _ => None,
    }
}

pub fn classify_closed_case_table_annotation(
    checker: &mut Checker,
    type_node: P<Node>,
) -> Option<&'static str> {
    let mut visited = FxHashSet::default();
    classify_closed_case_table_with_visited(checker, type_node, &mut visited)
}

#[must_use]
pub fn is_true_literal_type(typ: P<Type>) -> bool {
    is_type_flag_set(typ, TypeFlags::BooleanLiteral)
        && is_intrinsic_type(typ)
        && typ.as_intrinsic_type().intrinsic_name() == "true"
}

#[must_use]
pub fn is_false_literal_type(typ: P<Type>) -> bool {
    is_type_flag_set(typ, TypeFlags::BooleanLiteral)
        && is_intrinsic_type(typ)
        && typ.as_intrinsic_type().intrinsic_name() == "false"
}

pub fn type_literal_keys(typ: P<Type>, out: &mut FxHashSet<String>) {
    if is_union_type(typ) {
        for &part in typ.types() {
            type_literal_keys(part, out);
        }
        return;
    }
    if typ.is_string_literal() {
        if let Some(LiteralValue::String(val)) = typ.as_literal_type().value() {
            out.insert(format!("string:{val}"));
        }
        return;
    }
    if typ.is_number_literal() {
        if let Some(LiteralValue::Number(num)) = typ.as_literal_type().value() {
            out.insert(format!("number:{}", num.string()));
        }
        return;
    }
    if is_true_literal_type(typ) {
        out.insert("boolean:true".to_string());
    } else if is_false_literal_type(typ) {
        out.insert("boolean:false".to_string());
    }
}

pub fn has_string_or_number_index_signature(checker: &mut Checker, typ: P<Type>) -> bool {
    let str_type = checker.string_type;
    let num_type = checker.number_type;
    checker.get_index_type_of_type(typ, str_type).is_some()
        || checker.get_index_type_of_type(typ, num_type).is_some()
}

pub fn object_property_names(checker: &mut Checker, typ: P<Type>) -> Vec<String> {
    let props = checker.get_properties_of_type(typ);
    let mut names: Vec<String> = props
        .iter()
        .filter_map(|&prop| {
            let name = prop.name();
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect();
    names.sort();
    names
}

fn is_disallowed_bag_symbol(sym: Option<P<Symbol>>) -> bool {
    sym.is_some_and(|symbol| {
        NON_BAG_TYPE_NAMES.contains(&symbol.name())
            || symbol.flags.get().intersects(SymbolFlags::Class)
    })
}

fn is_callable_property(checker: &mut Checker, prop: P<Symbol>) -> bool {
    if prop.flags.get().intersects(SymbolFlags::Method) {
        return true;
    }
    let decls = provenance::symbol_declarations(checker, Some(prop));
    let Some(&first_decl) = decls.first() else {
        return false;
    };
    let Some(prop_type) = checker.get_type_of_symbol_at_location(prop, Some(first_decl)) else {
        return false;
    };
    for part in non_nullish_type_parts(prop_type) {
        if !get_call_signatures(checker, part).is_empty() {
            return true;
        }
    }
    false
}

fn is_plain_bag_constituent_type(checker: &mut Checker, constituent_type: P<Type>) -> bool {
    let disallowed_flags = TypeFlags::StringLike
        | TypeFlags::NumberLike
        | TypeFlags::BooleanLike
        | TypeFlags::BigIntLike
        | TypeFlags::ESSymbolLike
        | TypeFlags::EnumLike
        | TypeFlags::Never;
    if is_type_flag_set(constituent_type, disallowed_flags)
        || checker.is_array_type(constituent_type)
        || tsrs_checker::is_tuple_type_exported(constituent_type)
        || !get_call_signatures(checker, constituent_type).is_empty()
        || !get_construct_signatures(checker, constituent_type).is_empty()
        || is_disallowed_bag_symbol(provenance::type_symbol(constituent_type))
    {
        return false;
    }
    let props = checker.get_properties_of_type(constituent_type);
    let mut non_callable_props = 0usize;
    for &prop in props {
        if prop.flags.get().intersects(SymbolFlags::Method) {
            return false;
        }
        if !is_callable_property(checker, prop) {
            non_callable_props += 1;
        }
    }
    if is_type_flag_set(
        constituent_type,
        TypeFlags::Any | TypeFlags::Unknown | TypeFlags::TypeParameter,
    ) {
        return true;
    }
    if !is_object_type(constituent_type) {
        return false;
    }
    let str_type = checker.string_type;
    non_callable_props > 0
        || checker
            .get_index_type_of_type(constituent_type, str_type)
            .is_some()
}

pub fn is_plain_bag_type(checker: &mut Checker, typ: P<Type>) -> bool {
    let parts = non_nullish_type_parts(typ);
    !parts.is_empty()
        && parts
            .into_iter()
            .all(|part| is_plain_bag_constituent_type(checker, part))
}

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
        open.insert(name.to_string());
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
        Kind::Identifier => Some(type_name.as_identifier().text().to_string()),
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
        Kind::Identifier => Some(key.as_identifier().text().to_string()),
        Kind::StringLiteral => Some(key.as_string_literal().text().to_string()),
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
                vec![lit.as_string_literal().text().to_string()]
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
