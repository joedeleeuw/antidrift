use crate::tsrs_kernel::cooked_text;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Node, SourceFile, Symbol};
use tsrs_checker::{Checker, Signature, SignatureKind, Type};
use tsrs_core::P;

use super::service_tags::{
    ServiceTagInspection, extract_effect_success_type, inspect_service_tag_declarations,
    is_layer_construction_call, is_service_tag_call,
};
use crate::{provenance, shape};

#[derive(Clone, Debug, Default)]
pub struct ServiceProvenance {
    pub has_service_contract: bool,
    pub constructor_symbols: FxHashSet<P<Symbol>>,
}

struct LayerUsageTracker {
    import_decl: Option<P<Node>>,
    local_sym: P<Symbol>,
    stop_node: P<Node>,
    reference_count: usize,
    all_inside_layer: bool,
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

fn consumes_service_tag(
    checker: &mut Checker,
    node: P<Node>,
    tag_symbols: &FxHashSet<P<Symbol>>,
) -> bool {
    if ast::is_identifier(node)
        && provenance::symbol_at_node(checker, node).is_some_and(|s| tag_symbols.contains(&s))
    {
        let is_of = node.parent().is_some_and(|p| {
            ast::is_property_access_expression(p)
                && p.as_property_access_expression().expression() == node
                && cooked_text(p.as_property_access_expression().name()) == Some("of")
        });
        if !is_of {
            return true;
        }
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if !found && consumes_service_tag(checker, child, tag_symbols) {
            found = true;
        }
        false
    });
    found
}

fn matches_service_shape(
    checker: &mut Checker,
    candidate: P<Type>,
    service_shape: P<Type>,
) -> bool {
    !checker.get_properties_of_type(candidate).is_empty()
        && !checker.get_properties_of_type(service_shape).is_empty()
        && (shape::same_type(checker, candidate, service_shape)
            || checker.is_type_assignable_to(candidate, service_shape))
}

fn signature_takes_shape(
    checker: &mut Checker,
    sig: P<Signature>,
    decl: P<Node>,
    service_shape: P<Type>,
) -> bool {
    sig.parameters().iter().any(|&p| {
        checker
            .get_type_of_symbol_at_location(p, Some(decl))
            .is_some_and(|pt| matches_service_shape(checker, pt, service_shape))
    })
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
    if ast::get_source_file_of_node(decl) != Some(sf)
        || is_service_tag_or_layer_declaration(decl)
        || (!inspection.wired_set.contains(&candidate_symbol)
            && consumes_service_tag(checker, decl, &inspection.tag_symbols))
    {
        return false;
    }
    let Some(symbol_type) = checker.get_type_of_symbol_at_location(candidate_symbol, Some(decl))
    else {
        return false;
    };
    for &sig in checker.get_signatures_of_type(symbol_type, SignatureKind::Call) {
        let return_type = checker.get_return_type_of_signature(sig);
        let unwrapped = extract_effect_success_type(checker, return_type).unwrap_or(return_type);
        if inspection.service_shapes.iter().any(|&s| {
            !signature_takes_shape(checker, sig, decl, s)
                && matches_service_shape(checker, unwrapped, s)
        }) {
            return true;
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
    for candidate in inspection
        .wired_list
        .iter()
        .copied()
        .chain(collect_module_export_symbols(checker, module_symbol))
    {
        if !provenance_result.constructor_symbols.contains(&candidate)
            && is_service_constructor_candidate(checker, sf, candidate, &inspection)
        {
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
