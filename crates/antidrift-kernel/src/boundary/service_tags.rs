use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, ClassDeclaration, Kind, Node, SourceFile, Symbol};
use tsrs_checker::{Checker, ObjectFlags, SignatureKind, Type};
use tsrs_core::P;

use crate::provenance;

const SERVICE_TAG_FACTORIES: &[&str] = &["Tag", "GenericTag", "Service"];
const SERVICE_TAG_NAMESPACES: &[&str] = &["Context", "Effect"];
const LAYER_FACTORY_METHODS: &[&str] = &[
    "effect",
    "scoped",
    "succeed",
    "sync",
    "unwrapEffect",
    "unwrapScoped",
    "function",
    "effectContext",
    "scopedContext",
];

#[derive(Default)]
pub(super) struct ServiceTagInspection {
    pub(super) service_shapes: Vec<P<Type>>,
    pub(super) tag_symbols: FxHashSet<P<Symbol>>,
    pub(super) wired_set: FxHashSet<P<Symbol>>,
    pub(super) wired_list: Vec<P<Symbol>>,
}

fn callee_namespace_and_method(expr: P<Node>) -> Option<(&'static str, &'static str)> {
    if ast::is_property_access_expression(expr) {
        let pa = expr.as_property_access_expression();
        if ast::is_identifier(pa.expression()) {
            return Some((pa.expression().as_identifier().text(), pa.name().text()));
        }
    }
    ast::is_identifier(expr).then(|| ("", expr.as_identifier().text()))
}

pub(super) fn is_service_tag_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let expr = node.as_call_expression().expression();
    if let Some((ns, method)) = callee_namespace_and_method(expr)
        && SERVICE_TAG_FACTORIES.contains(&method)
        && (ns.is_empty() || SERVICE_TAG_NAMESPACES.contains(&ns))
    {
        return true;
    }
    ast::is_call_expression(expr) && is_service_tag_call(expr)
}

#[must_use]
pub fn is_layer_construction_call(node: P<Node>) -> bool {
    ast::is_call_expression(node)
        && callee_namespace_and_method(node.as_call_expression().expression())
            .is_some_and(|(ns, method)| ns == "Layer" && LAYER_FACTORY_METHODS.contains(&method))
}

fn extract_service_shape_type_from_tag_call(
    checker: &mut Checker,
    call_node: P<Node>,
) -> Option<P<Type>> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let type_args = call_node.type_arguments();
    if let Some(&shape_node) = type_args.get(1).or_else(|| type_args.first()) {
        return Some(checker.get_type_from_type_node_exported(shape_node));
    }
    let expr = call_node.as_call_expression().expression();
    ast::is_call_expression(expr)
        .then(|| extract_service_shape_type_from_tag_call(checker, expr))
        .flatten()
}

fn is_symbol_declared_in_source_file(sym: P<Symbol>, sf: P<SourceFile>) -> bool {
    sym.declarations()
        .iter()
        .any(|&decl| ast::get_source_file_of_node(decl) == Some(sf))
}

fn collect_referenced_local_symbols(
    checker: &mut Checker,
    current_node: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    if ast::is_identifier(current_node)
        && let Some(resolved) = provenance::symbol_at_node(checker, current_node)
        && is_symbol_declared_in_source_file(resolved, sf)
        && inspection.wired_set.insert(resolved)
    {
        inspection.wired_list.push(resolved);
    }
    current_node.for_each_child(&mut |child| {
        collect_referenced_local_symbols(checker, child, sf, inspection);
        false
    });
}

fn inspect_service_config_object(
    checker: &mut Checker,
    obj: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    for &prop in obj.as_object_literal_expression().properties().nodes() {
        if !prop
            .name()
            .and_then(crate::tsrs_kernel::property_name_text)
            .is_some_and(|n| matches!(n, "effect" | "scoped" | "sync" | "succeed"))
        {
            continue;
        }
        let val = if ast::is_property_assignment(prop) {
            prop.as_property_assignment().initializer()
        } else {
            prop
        };
        collect_referenced_local_symbols(checker, val, sf, inspection);
        let val_type = checker.get_type_at_location(val);
        let candidate_type = checker
            .get_signatures_of_type(val_type, SignatureKind::Call)
            .first()
            .map_or(val_type, |&sig| checker.get_return_type_of_signature(sig));
        inspection
            .service_shapes
            .push(extract_effect_success_type(checker, candidate_type).unwrap_or(candidate_type));
    }
}

fn inspect_heritage_type_node(
    checker: &mut Checker,
    type_node: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) -> bool {
    if !ast::is_expression_with_type_arguments(type_node) {
        return false;
    }
    let expr = type_node.as_expression_with_type_arguments().expression();
    if !ast::is_call_expression(expr) || !is_service_tag_call(expr) {
        return false;
    }
    if let Some(shape_type) = extract_service_shape_type_from_tag_call(checker, expr) {
        inspection.service_shapes.push(shape_type);
    }
    for &arg in expr.as_call_expression().arguments().nodes() {
        if ast::is_object_literal_expression(arg) {
            inspect_service_config_object(checker, arg, sf, inspection);
        }
    }
    true
}

fn inspect_class_service_tags(
    checker: &mut Checker,
    cls: &ClassDeclaration,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    let Some(clauses) = cls.heritage_clauses() else {
        return;
    };
    let mut is_tag = false;
    for &clause_node in clauses.nodes() {
        for &type_node in clause_node.as_heritage_clause().types().nodes() {
            is_tag |= inspect_heritage_type_node(checker, type_node, sf, inspection);
        }
    }
    if is_tag
        && let Some(name) = cls.name()
        && let Some(sym) = provenance::symbol_at_node(checker, name)
    {
        inspection.tag_symbols.insert(sym);
    }
}

fn service_shape_from_wiring_tag(checker: &mut Checker, service_tag: P<Node>) -> Option<P<Type>> {
    let tag_type = checker.get_type_at_location(service_tag);
    let prop = checker.get_property_of_type(tag_type, "Service")?;
    checker.get_type_of_symbol_at_location(prop, Some(service_tag))
}

fn inspect_layer_call_arguments(
    checker: &mut Checker,
    call_node: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    let args = call_node.as_call_expression().arguments().nodes();
    if args.is_empty() {
        return;
    }
    if args.len() >= 2 {
        if let Some(sym) = provenance::symbol_at_node(checker, args[0]) {
            inspection.tag_symbols.insert(sym);
        }
        if let Some(shape_type) = service_shape_from_wiring_tag(checker, args[0]) {
            inspection.service_shapes.push(shape_type);
        }
    }
    let provider_args = if args.len() >= 2 { &args[1..] } else { args };
    for &arg in provider_args {
        collect_referenced_local_symbols(checker, arg, sf, inspection);
    }
}

fn visit_service_tag_node(
    checker: &mut Checker,
    node: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    match node.kind() {
        Kind::ClassDeclaration => {
            inspect_class_service_tags(checker, node.as_class_declaration(), sf, inspection);
        }
        Kind::VariableDeclaration => {
            let vd = node.as_variable_declaration();
            if let Some(init) = vd.initializer()
                && is_service_tag_call(init)
            {
                if let Some(sym) = provenance::symbol_at_node(checker, vd.name()) {
                    inspection.tag_symbols.insert(sym);
                }
                if let Some(shape_type) = extract_service_shape_type_from_tag_call(checker, init) {
                    inspection.service_shapes.push(shape_type);
                }
            }
        }
        Kind::CallExpression if is_layer_construction_call(node) => {
            inspect_layer_call_arguments(checker, node, sf, inspection);
        }
        _ => {}
    }
    node.for_each_child(&mut |child| {
        visit_service_tag_node(checker, child, sf, inspection);
        false
    });
}

pub(super) fn inspect_service_tag_declarations(
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> ServiceTagInspection {
    let mut inspection = ServiceTagInspection::default();
    sf.as_node().for_each_child(&mut |child| {
        visit_service_tag_node(checker, child, sf, &mut inspection);
        false
    });
    inspection
}

fn has_effect_type_id_property(checker: &mut Checker, candidate_type: P<Type>) -> bool {
    checker
        .get_properties_of_type(candidate_type)
        .iter()
        .any(|&prop| prop.name().contains("EffectTypeId"))
}

pub(super) fn extract_effect_success_type(
    checker: &mut Checker,
    candidate_type: P<Type>,
) -> Option<P<Type>> {
    let sym_name = provenance::type_symbol(candidate_type)
        .as_deref()
        .map(Symbol::name)
        .unwrap_or("");
    if sym_name == "Effect" {
        if let Some(alias) = candidate_type.alias()
            && let Some(&first_arg) = alias.type_arguments().first()
        {
            return Some(first_arg);
        }
        if let Some(&first_arg) = checker.get_type_arguments_exported(candidate_type).first() {
            return Some(first_arg);
        }
    }
    if candidate_type
        .object_flags()
        .intersects(ObjectFlags::Reference)
        && let Some(&first_arg) = checker.get_type_arguments_exported(candidate_type).first()
        && has_effect_type_id_property(checker, candidate_type)
    {
        return Some(first_arg);
    }
    None
}
