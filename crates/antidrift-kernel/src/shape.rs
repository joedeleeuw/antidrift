use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, MappedTypeNode, Node, Symbol, SymbolFlags, TypeReferenceNode};
use tsrs_checker::{Checker, LiteralValue, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{
    get_call_signatures, get_construct_signatures, is_intrinsic_type, is_object_type,
    is_type_flag_set, is_union_type, union_type_parts,
};

use crate::provenance;

const NON_BAG_TYPE_NAMES: &[&str] = &[
    "AbortController",
    "AbortSignal",
    "Array",
    "ArrayBuffer",
    "Blob",
    "Buffer",
    "Checker",
    "CustomEvent",
    "DataView",
    "Date",
    "Document",
    "Element",
    "Error",
    "Event",
    "File",
    "FormData",
    "Function",
    "Headers",
    "HTMLElement",
    "Map",
    "Node",
    "Program",
    "Promise",
    "RangeError",
    "ReadableStream",
    "ReadonlyArray",
    "ReadonlyMap",
    "ReadonlySet",
    "ReferenceError",
    "RegExp",
    "Request",
    "Response",
    "RuleContext",
    "Set",
    "SharedArrayBuffer",
    "Signature",
    "SourceCode",
    "SourceFile",
    "Symbol",
    "SyntaxError",
    "TransformStream",
    "Type",
    "TypeChecker",
    "TypeError",
    "Uint8Array",
    "URL",
    "URLSearchParams",
    "WeakMap",
    "WeakSet",
    "Window",
    "WritableStream",
];

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

fn classify_closed_mapped_type(checker: &mut Checker, mapped: &MappedTypeNode) -> &'static str {
    if mapped.question_token().is_some() {
        return "";
    }
    let tp_node = mapped.type_parameter();
    let Some(constraint) = tp_node.as_type_parameter_declaration().constraint() else {
        return "";
    };
    let constraint_type = checker.get_type_from_type_node(constraint);
    if is_closed_key_domain_type(constraint_type) {
        "mapped type"
    } else {
        ""
    }
}

fn classify_closed_type_reference(
    checker: &mut Checker,
    type_ref: &TypeReferenceNode,
    visited: &mut FxHashSet<P<Symbol>>,
) -> &'static str {
    if ast::is_identifier(type_ref.type_name())
        && type_ref.type_name().as_identifier().text() == "Record"
        && let Some(args) = type_ref.type_arguments()
        && args.nodes().len() == 2
    {
        let key_type = checker.get_type_from_type_node(args.nodes()[0]);
        return if is_closed_key_domain_type(key_type) {
            "Record<K, V>"
        } else {
            ""
        };
    }
    let Some(sym) = provenance::symbol_at_node(checker, type_ref.type_name()) else {
        return "";
    };
    if !visited.insert(sym) {
        return "";
    }
    for decl in provenance::symbol_declarations(checker, Some(sym)) {
        if decl.kind() == Kind::TypeAliasDeclaration
            && let Some(alias_type) = decl.as_type_alias_declaration().type_()
        {
            let matched = classify_closed_case_table_with_visited(checker, alias_type, visited);
            if !matched.is_empty() {
                return matched;
            }
        }
    }
    ""
}

fn classify_closed_case_table_with_visited(
    checker: &mut Checker,
    type_node: P<Node>,
    visited: &mut FxHashSet<P<Symbol>>,
) -> &'static str {
    let current = unwrap_transparent_type_node(type_node);
    match current.kind() {
        Kind::MappedType => classify_closed_mapped_type(checker, current.as_mapped_type_node()),
        Kind::TypeReference => {
            classify_closed_type_reference(checker, current.as_type_reference_node(), visited)
        }
        _ => "",
    }
}

pub fn classify_closed_case_table_annotation(
    checker: &mut Checker,
    type_node: P<Node>,
) -> &'static str {
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
    let Some(symbol) = sym else {
        return false;
    };
    if NON_BAG_TYPE_NAMES.contains(&symbol.name()) {
        return true;
    }
    symbol.flags.get().intersects(SymbolFlags::Class)
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
    for &prop in props {
        if is_callable_property(checker, prop) {
            return false;
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
    !props.is_empty()
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
