use antidrift_kernel::tsrs_kernel;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, Symbol, SymbolFlags};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{
    get_call_signatures, is_intersection_type, is_intrinsic_error_type, is_object_type,
    is_type_flag_set, is_union_type, union_type_parts,
};

use super::predicate_scan::{BodyScanState, scan_body_node, unit_literal_key};

fn is_broad_predicate_input_type(checker: &mut Checker, typ: P<Type>) -> bool {
    if is_type_flag_set(typ, TypeFlags::AnyOrUnknown) {
        return true;
    }
    if !is_object_type(typ) || !checker.get_properties_of_type(typ).is_empty() {
        return false;
    }
    let str_type = checker.string_type;
    let num_type = checker.number_type;
    let str_idx = checker.get_index_type_of_type(typ, str_type);
    let num_idx = checker.get_index_type_of_type(typ, num_type);
    (str_idx.is_none() && num_idx.is_none())
        || str_idx.is_some_and(|i| is_type_flag_set(i, TypeFlags::AnyOrUnknown))
        || num_idx.is_some_and(|i| is_type_flag_set(i, TypeFlags::AnyOrUnknown))
}

fn is_object_contract(checker: &mut Checker, typ: P<Type>) -> bool {
    let is_obj = if is_union_type(typ) {
        false
    } else if is_intersection_type(typ) {
        typ.types()
            .iter()
            .copied()
            .any(|p| is_object_contract(checker, p))
    } else {
        is_object_type(typ)
    };
    is_obj && !checker.is_array_type(typ) && !tsrs_checker::is_tuple_type_exported(typ)
}

fn required_type_props(checker: &mut Checker, typ: P<Type>) -> Vec<String> {
    let props = checker.get_properties_of_type(typ);
    let mut names = Vec::new();
    for &prop in props {
        if !prop.flags.get().intersects(SymbolFlags::Optional) {
            let prop_type = checker.get_type_of_symbol(prop);
            if get_call_signatures(checker, prop_type).is_empty() {
                names.push(prop.name().to_string());
            }
        }
    }
    names
}

fn variant_accepted_by_tags(
    variant: P<Type>,
    checker: &mut Checker,
    state: &BodyScanState,
) -> bool {
    for field in &state.tag_fields {
        let Some(allowed) = state.tag_literals.get(field) else {
            continue;
        };
        let Some(prop_sym) = checker.get_property_of_type(variant, field) else {
            continue;
        };
        let prop_type = checker.get_type_of_symbol(prop_sym);
        if let Some(tag_key) = unit_literal_key(prop_type)
            && !allowed.contains(&tag_key)
        {
            return false;
        }
    }
    true
}

fn prop_has_unchecked_payload(
    checker: &mut Checker,
    prop: P<Symbol>,
    state: &BodyScanState,
) -> bool {
    let prefix = format!("{}.", prop.name());
    if !state
        .checked_path_list
        .iter()
        .any(|p| p.starts_with(&prefix))
    {
        return false;
    }
    let raw = checker.get_type_of_symbol(prop);
    let payload = checker.get_non_nullable_type(raw);
    if !is_object_contract(checker, payload) {
        return false;
    }
    required_type_props(checker, payload)
        .into_iter()
        .any(|nested| !state.checked_paths.contains(&format!("{prefix}{nested}")))
}

fn has_unchecked_probed_payload(
    checker: &mut Checker,
    variants: &[P<Type>],
    state: &BodyScanState,
) -> bool {
    for &variant in variants {
        let props = checker.get_properties_of_type(variant);
        for &prop in props {
            if prop_has_unchecked_payload(checker, prop, state) {
                return true;
            }
        }
    }
    false
}

fn collect_required_variant_props(
    checker: &mut Checker,
    variants: &[P<Type>],
    state: &BodyScanState,
) -> Vec<String> {
    let mut target_props = Vec::new();
    let mut seen = FxHashSet::default();
    for &variant in variants {
        if !variant_accepted_by_tags(variant, checker, state) {
            continue;
        }
        for req in required_type_props(checker, variant) {
            if seen.insert(req.clone()) {
                target_props.push(req);
            }
        }
    }
    target_props
}

fn check_function(ctx: &mut Ctx, fn_node: P<Node>) {
    let Some(ret_type) = tsrs_kernel::function_return_type_node(fn_node) else {
        return;
    };
    if ret_type.kind() != Kind::TypePredicate {
        return;
    }
    let pred = ret_type.as_type_predicate_node();
    if !ast::is_identifier(pred.parameter_name()) {
        return;
    }
    let (Some(target_type_node), Some(body)) = (pred.type_(), fn_node.body()) else {
        return;
    };
    let param_name = pred.parameter_name().as_identifier().text();
    let Some(param_ident) = fn_node
        .parameters()
        .iter()
        .filter_map(|&p| p.name())
        .find(|&n| ast::is_identifier(n) && n.as_identifier().text() == param_name)
    else {
        return;
    };
    let param_type = ctx.checker.get_type_at_location(param_ident);
    if is_intrinsic_error_type(param_type)
        || !is_broad_predicate_input_type(ctx.checker, param_type)
    {
        return;
    }
    let target_type = ctx.checker.get_type_from_type_node(target_type_node);
    let variants = union_type_parts(target_type);
    if variants.is_empty() || !variants.iter().all(|&v| is_object_contract(ctx.checker, v)) {
        return;
    }
    let mut state = BodyScanState::new(param_name);
    scan_body_node(body, target_type, ctx.checker, &mut state);
    if state.proven {
        return;
    }
    let target_props = collect_required_variant_props(ctx.checker, &variants, &state);
    if target_props.is_empty()
        || (target_props.iter().all(|p| state.checked_props.contains(p))
            && !has_unchecked_probed_payload(ctx.checker, &variants, &state))
    {
        return;
    }
    ctx.report_node(
        ret_type,
        RuleMessage::new(
            "undercheckedTypePredicate",
            "Do not narrow broad input with an under-checked type predicate. Check the asserted fields or delegate to an owned schema/validator.",
        ),
    );
}

pub struct NoUndercheckedTypePredicate;

#[must_use]
pub fn create(_options: Option<&serde_json::Value>) -> Box<dyn Rule> {
    Box::new(NoUndercheckedTypePredicate)
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
];

impl Rule for NoUndercheckedTypePredicate {
    fn name(&self) -> &'static str {
        "antidrift/no-underchecked-type-predicate"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_function(ctx, node);
    }
}
