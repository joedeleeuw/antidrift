use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, ClassDeclaration, Kind, Node, SourceFile, Symbol};
use tsrs_checker::{Checker, ObjectFlags, SignatureKind, Type};
use tsrs_core::P;

use crate::{provenance, shape};

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

#[derive(Clone, Debug, Default)]
pub struct ServiceProvenance {
    pub has_service_contract: bool,
    pub constructor_symbols: FxHashSet<P<Symbol>>,
}

#[derive(Default)]
struct ServiceTagInspection {
    service_shapes: Vec<P<Type>>,
    wired_set: FxHashSet<P<Symbol>>,
    wired_list: Vec<P<Symbol>>,
}

impl ServiceTagInspection {
    fn record_wired(&mut self, sym: P<Symbol>) {
        if self.wired_set.insert(sym) {
            self.wired_list.push(sym);
        }
    }
}

struct LayerUsageTracker {
    import_decl: Option<P<Node>>,
    local_sym: P<Symbol>,
    stop_node: P<Node>,
    reference_count: usize,
    all_inside_layer: bool,
}

fn callee_namespace_and_method(expr: P<Node>) -> Option<(&'static str, &'static str)> {
    if ast::is_property_access_expression(expr) {
        let pa = expr.as_property_access_expression();
        if ast::is_identifier(pa.expression()) {
            return Some((pa.expression().as_identifier().text(), pa.name().text()));
        }
    }
    if ast::is_identifier(expr) {
        return Some(("", expr.as_identifier().text()));
    }
    None
}

fn is_service_tag_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let call = node.as_call_expression();
    if let Some((ns, method)) = callee_namespace_and_method(call.expression()) {
        let is_factory = SERVICE_TAG_FACTORIES.contains(&method);
        let is_ns = SERVICE_TAG_NAMESPACES.contains(&ns);
        if is_factory && (ns.is_empty() || is_ns) {
            return true;
        }
    }
    if ast::is_call_expression(call.expression()) {
        return is_service_tag_call(call.expression());
    }
    false
}

#[must_use]
pub fn is_layer_construction_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let Some((ns, method)) = callee_namespace_and_method(node.as_call_expression().expression())
    else {
        return false;
    };
    ns == "Layer" && LAYER_FACTORY_METHODS.contains(&method)
}

fn extract_service_shape_type_from_tag_call(
    checker: &mut Checker,
    call_node: P<Node>,
) -> Option<P<Type>> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let type_args = call_node.type_arguments();
    if !type_args.is_empty() {
        let shape_node = if type_args.len() >= 2 {
            type_args[1]
        } else {
            type_args[0]
        };
        return Some(checker.get_type_from_type_node_exported(shape_node));
    }
    let expr = call_node.as_call_expression().expression();
    if ast::is_call_expression(expr) {
        return extract_service_shape_type_from_tag_call(checker, expr);
    }
    None
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
    {
        inspection.record_wired(resolved);
    }
    current_node.for_each_child(&mut |child| {
        collect_referenced_local_symbols(checker, child, sf, inspection);
        false
    });
}

fn inspect_heritage_type_node(
    checker: &mut Checker,
    type_node: P<Node>,
    sf: P<SourceFile>,
    inspection: &mut ServiceTagInspection,
) {
    if !ast::is_expression_with_type_arguments(type_node) {
        return;
    }
    let expr = type_node.as_expression_with_type_arguments().expression();
    if !ast::is_call_expression(expr) || !is_service_tag_call(expr) {
        return;
    }
    if let Some(shape_type) = extract_service_shape_type_from_tag_call(checker, expr) {
        inspection.service_shapes.push(shape_type);
    }
    for &arg in expr.as_call_expression().arguments().nodes() {
        if ast::is_object_literal_expression(arg) {
            collect_referenced_local_symbols(checker, arg, sf, inspection);
        }
    }
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
    for &clause_node in clauses.nodes() {
        let hc = clause_node.as_heritage_clause();
        for &type_node in hc.types().nodes() {
            inspect_heritage_type_node(checker, type_node, sf, inspection);
        }
    }
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
                && let Some(shape_type) = extract_service_shape_type_from_tag_call(checker, init)
            {
                inspection.service_shapes.push(shape_type);
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

fn inspect_service_tag_declarations(
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

fn extract_effect_success_type(checker: &mut Checker, candidate_type: P<Type>) -> Option<P<Type>> {
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

fn collect_module_export_symbols(
    checker: &mut Checker,
    module_symbol: Option<P<Symbol>>,
) -> Vec<P<Symbol>> {
    let Some(mod_sym) = module_symbol else {
        return Vec::new();
    };
    let mut seen = FxHashSet::default();
    let mut exports = Vec::new();
    if let Some(export_table) = mod_sym.exports() {
        for exp in export_table.values() {
            let resolved = provenance::resolve_aliased_symbol(checker, exp);
            if seen.insert(resolved) {
                exports.push(resolved);
            }
        }
    }
    let module_type = checker.get_type_of_symbol(mod_sym);
    for &prop in checker.get_properties_of_type(module_type) {
        let resolved = provenance::resolve_aliased_symbol(checker, prop);
        if seen.insert(resolved) {
            exports.push(resolved);
        }
    }
    exports
}

fn is_service_tag_or_layer_declaration(decl: P<Node>) -> bool {
    if ast::is_class_declaration(decl) {
        return true;
    }
    if ast::is_variable_declaration(decl)
        && let Some(init) = decl.as_variable_declaration().initializer()
        && ast::is_call_expression(init)
        && (is_service_tag_call(init) || is_layer_construction_call(init))
    {
        return true;
    }
    false
}

fn is_service_constructor_candidate(
    checker: &mut Checker,
    sf: P<SourceFile>,
    candidate_symbol: P<Symbol>,
    inspection: &ServiceTagInspection,
) -> bool {
    let Some(decl) = candidate_symbol
        .value_declaration()
        .or_else(|| candidate_symbol.declarations().first().copied())
    else {
        return false;
    };
    if ast::get_source_file_of_node(decl) != Some(sf) || is_service_tag_or_layer_declaration(decl) {
        return false;
    }
    let Some(symbol_type) = checker.get_type_of_symbol_at_location(candidate_symbol, Some(decl))
    else {
        return false;
    };
    let call_signatures = checker.get_signatures_of_type(symbol_type, SignatureKind::Call);
    if call_signatures.is_empty() {
        return false;
    }
    if inspection.wired_set.contains(&candidate_symbol) {
        return true;
    }
    for &sig in call_signatures {
        let return_type = checker.get_return_type_of_signature(sig);
        let unwrapped = extract_effect_success_type(checker, return_type).unwrap_or(return_type);
        if checker.get_properties_of_type(unwrapped).is_empty() {
            continue;
        }
        for &service_shape in &inspection.service_shapes {
            if shape::same_type(checker, unwrapped, service_shape) {
                return true;
            }
        }
    }
    false
}

pub fn service_contract_provenance(
    checker: &mut Checker,
    module_symbol: Option<P<Symbol>>,
    sf: P<SourceFile>,
) -> ServiceProvenance {
    let mut provenance_result = ServiceProvenance::default();
    let inspection = inspect_service_tag_declarations(checker, sf);
    provenance_result.has_service_contract =
        !inspection.service_shapes.is_empty() || !inspection.wired_list.is_empty();
    if !provenance_result.has_service_contract {
        return provenance_result;
    }
    let mut seen_candidates = FxHashSet::default();
    let mut candidate_list = Vec::new();
    for &sym in &inspection.wired_list {
        if seen_candidates.insert(sym) {
            candidate_list.push(sym);
        }
    }
    for exp in collect_module_export_symbols(checker, module_symbol) {
        if seen_candidates.insert(exp) {
            candidate_list.push(exp);
        }
    }
    for candidate in candidate_list {
        if is_service_constructor_candidate(checker, sf, candidate, &inspection) {
            provenance_result.constructor_symbols.insert(candidate);
        }
    }
    provenance_result
}

fn is_inside_layer_construction(node: P<Node>, stop_node: P<Node>) -> bool {
    let mut current = node.parent();
    while let Some(curr) = current {
        if curr == stop_node {
            break;
        }
        if ast::is_call_expression(curr) && is_layer_construction_call(curr) {
            return true;
        }
        current = curr.parent();
    }
    false
}

fn visit_layer_construction_usage(
    checker: &mut Checker,
    current_node: P<Node>,
    tracker: &mut LayerUsageTracker,
) {
    if !tracker.all_inside_layer || tracker.import_decl == Some(current_node) {
        return;
    }
    if ast::is_identifier(current_node)
        && checker.get_symbol_at_location_exported(current_node) == Some(tracker.local_sym)
    {
        tracker.reference_count += 1;
        if !is_inside_layer_construction(current_node, tracker.stop_node) {
            tracker.all_inside_layer = false;
            return;
        }
    }
    current_node.for_each_child(&mut |child| {
        visit_layer_construction_usage(checker, child, tracker);
        false
    });
}

pub fn is_only_used_in_layer_construction(
    checker: &mut Checker,
    sf: P<SourceFile>,
    import_decl: Option<P<Node>>,
    local_ident: P<Node>,
) -> bool {
    let Some(local_sym) = checker.get_symbol_at_location_exported(local_ident) else {
        return false;
    };
    let stop_node = sf.as_node();
    let mut tracker = LayerUsageTracker {
        import_decl,
        local_sym,
        stop_node,
        reference_count: 0,
        all_inside_layer: true,
    };
    stop_node.for_each_child(&mut |child| {
        visit_layer_construction_usage(checker, child, &mut tracker);
        false
    });
    tracker.reference_count > 0 && tracker.all_inside_layer
}
