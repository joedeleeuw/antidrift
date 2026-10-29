use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node, SourceFile, SymbolFlags};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{is_intersection_type, is_object_type, is_type_flag_set, is_union_type};

use crate::{shape, tsrs_kernel};

pub struct ConstantReturnFieldViolation {
    pub report_node: P<Node>,
    pub contract_name: String,
    pub field_name: String,
    pub constant_literal: &'static str,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum ContractGroupKey {
    Named(String),
    Inline(usize),
}

struct FunctionContractEntry {
    fn_node: P<Node>,
    candidate_node: P<Node>,
    contract_type_node: P<Node>,
    contract_label: String,
}

struct ObjectReturnSite {
    fields: FxHashMap<String, (Option<&'static str>, String)>,
    ordered_boolean_fields: Vec<(String, &'static str, P<Node>)>,
}

fn unwrap_return_contract_type_node(type_node: P<Node>) -> P<Node> {
    let current = shape::unwrap_transparent_type_node(type_node);
    if current.kind() == Kind::TypeReference {
        let type_ref = current.as_type_reference_node();
        if ast::is_identifier(type_ref.type_name())
            && matches!(
                type_ref.type_name().as_identifier().text(),
                "Promise" | "PromiseLike"
            )
            && let Some(args) = type_ref.type_arguments()
            && args.nodes().len() == 1
        {
            return shape::unwrap_transparent_type_node(args.nodes()[0]);
        }
    }
    current
}

fn candidate_function_name(fn_node: P<Node>, candidate_node: P<Node>) -> Option<&'static str> {
    if let Some(name) = tsrs_kernel::function_name(fn_node) {
        return Some(name);
    }
    let name_node = match candidate_node.kind() {
        Kind::VariableDeclaration => Some(candidate_node.as_variable_declaration().name()),
        Kind::MethodDeclaration
        | Kind::PropertyDeclaration
        | Kind::PropertyAssignment
        | Kind::FunctionDeclaration => candidate_node.name(),
        _ => None,
    }?;
    ast::is_identifier(name_node).then(|| name_node.as_identifier().text())
}

fn is_error_or_failure_function_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("error") || lower.contains("failure") || lower.contains("fail")
}

fn classify_contract_target(
    fn_node: P<Node>,
    candidate_node: P<Node>,
    idx: usize,
) -> Option<(ContractGroupKey, FunctionContractEntry)> {
    let raw_ret = tsrs_kernel::function_return_type_node(fn_node)?;
    let contract_type_node = unwrap_return_contract_type_node(raw_ret);
    match contract_type_node.kind() {
        Kind::TypeReference => {
            let name = shape::type_reference_name(
                contract_type_node.as_type_reference_node().type_name(),
            )?;
            Some((
                ContractGroupKey::Named(name.clone()),
                FunctionContractEntry {
                    fn_node,
                    candidate_node,
                    contract_type_node,
                    contract_label: name,
                },
            ))
        }
        Kind::TypeLiteral => {
            let label = candidate_function_name(fn_node, candidate_node)
                .unwrap_or("inline return contract")
                .to_owned();
            Some((
                ContractGroupKey::Inline(idx),
                FunctionContractEntry {
                    fn_node,
                    candidate_node,
                    contract_type_node,
                    contract_label: label,
                },
            ))
        }
        _ => None,
    }
}

fn is_delegating_call_return(expr: P<Node>) -> bool {
    let mut current = tsrs_kernel::unwrap_expression(expr);
    if current.kind() == Kind::AwaitExpression {
        current = tsrs_kernel::unwrap_expression(current.as_await_expression().expression());
    }
    current.kind() == Kind::CallExpression
}

fn collect_object_literals_from_return_expr(expr: P<Node>, out: &mut Vec<P<Node>>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(expr);
    if ast::is_object_literal_expression(unwrapped) {
        out.push(unwrapped);
        return true;
    }
    if ast::is_conditional_expression(unwrapped) {
        let cond = unwrapped.as_conditional_expression();
        return collect_object_literals_from_return_expr(cond.when_true(), out)
            && collect_object_literals_from_return_expr(cond.when_false(), out);
    }
    is_delegating_call_return(unwrapped)
}

fn has_bare_return_statement(node: P<Node>) -> bool {
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found || tsrs_kernel::is_function_like(child) {
            return found;
        }
        if child.kind() == Kind::ReturnStatement
            && child.as_return_statement().expression().is_none()
        {
            found = true;
            return true;
        }
        if has_bare_return_statement(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn parse_object_return_site(sf: P<SourceFile>, obj_node: P<Node>) -> Option<ObjectReturnSite> {
    let props = obj_node.as_object_literal_expression().properties().nodes();
    if props.is_empty() {
        return None;
    }
    let mut fields = FxHashMap::default();
    let mut ordered_boolean_fields = Vec::new();
    for &prop in props {
        match prop.kind() {
            Kind::PropertyAssignment => {
                let pa = prop.as_property_assignment();
                let key = shape::property_key_name(pa.name())?;
                let init = tsrs_kernel::unwrap_expression(pa.initializer());
                let raw_text = tsrs_kernel::node_text(sf, init).trim().to_owned();
                let bool_lit = match init.kind() {
                    Kind::TrueKeyword => Some("true"),
                    Kind::FalseKeyword => Some("false"),
                    _ => None,
                };
                if let Some(lit) = bool_lit {
                    ordered_boolean_fields.push((key.clone(), lit, prop));
                }
                fields.insert(key, (bool_lit, raw_text));
            }
            Kind::ShorthandPropertyAssignment => {
                let shorthand = prop.as_shorthand_property_assignment();
                if shorthand.object_assignment_initializer().is_some() {
                    return None;
                }
                let name_node = shorthand.name();
                if !ast::is_identifier(name_node) {
                    return None;
                }
                let key = name_node.as_identifier().text().to_owned();
                fields.insert(key.clone(), (None, key));
            }
            _ => return None,
        }
    }
    Some(ObjectReturnSite {
        fields,
        ordered_boolean_fields,
    })
}

fn collect_group_return_sites(
    entries: &[FunctionContractEntry],
    sf: P<SourceFile>,
) -> Option<Vec<ObjectReturnSite>> {
    let mut sites = Vec::new();
    for entry in entries {
        let body = tsrs_kernel::function_body_node(entry.fn_node)?;
        if !ast::is_block(body) || has_bare_return_statement(body) {
            return None;
        }
        let return_exprs = tsrs_kernel::collect_return_expressions(Some(body));
        if return_exprs.is_empty() {
            return None;
        }
        let mut obj_nodes = Vec::new();
        for ret_expr in return_exprs {
            if !collect_object_literals_from_return_expr(ret_expr, &mut obj_nodes) {
                return None;
            }
        }
        for obj_node in obj_nodes {
            sites.push(parse_object_return_site(sf, obj_node)?);
        }
    }
    (sites.len() >= 2 && sites_have_varying_branch(&sites)).then_some(sites)
}

fn sites_have_varying_branch(sites: &[ObjectReturnSite]) -> bool {
    let Some(first) = sites.first() else {
        return false;
    };
    sites.iter().skip(1).any(|site| {
        site.fields.len() != first.fields.len()
            || first.fields.iter().any(|(key, (_, first_raw))| {
                site.fields
                    .get(key)
                    .is_none_or(|(_, other_raw)| other_raw != first_raw)
            })
    })
}

fn is_wide_non_optional_boolean_property(
    checker: &mut Checker,
    target_type: P<Type>,
    contract_type_node: P<Node>,
    field_name: &str,
) -> bool {
    let Some(prop_sym) = checker.get_property_of_type(target_type, field_name) else {
        return false;
    };
    if prop_sym.flags.get().intersects(SymbolFlags::Optional) {
        return false;
    }
    let Some(prop_type) =
        checker.get_type_of_symbol_at_location(prop_sym, Some(contract_type_node))
    else {
        return false;
    };
    let non_null = shape::non_nullish_type_parts(prop_type);
    if non_null.is_empty()
        || !non_null
            .iter()
            .all(|&part| is_type_flag_set(part, TypeFlags::BooleanLike))
    {
        return false;
    }
    if is_type_flag_set(prop_type, TypeFlags::Boolean)
        && !is_type_flag_set(prop_type, TypeFlags::BooleanLiteral)
    {
        return true;
    }
    let mut keys = FxHashSet::default();
    shape::type_literal_keys(prop_type, &mut keys);
    keys.contains("boolean:true") && keys.contains("boolean:false")
}

pub fn find_constant_return_field_violations(
    candidates: &[(P<Node>, P<Node>)],
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> Vec<ConstantReturnFieldViolation> {
    let mut group_order: Vec<ContractGroupKey> = Vec::new();
    let mut groups: FxHashMap<ContractGroupKey, Vec<FunctionContractEntry>> = FxHashMap::default();
    for (idx, &(fn_node, candidate_node)) in candidates.iter().enumerate() {
        let Some((key, entry)) = classify_contract_target(fn_node, candidate_node, idx) else {
            continue;
        };
        if !groups.contains_key(&key) {
            group_order.push(key.clone());
        }
        groups.entry(key).or_default().push(entry);
    }

    let mut violations = Vec::new();
    for key in group_order {
        let Some(entries) = groups.get(&key) else {
            continue;
        };
        let Some(first_entry) = entries.first() else {
            continue;
        };
        let target_type = checker.get_type_from_type_node_exported(first_entry.contract_type_node);
        if is_union_type(target_type)
            || is_intersection_type(target_type)
            || !is_object_type(target_type)
            || !shape::is_specific_type(target_type)
        {
            continue;
        }
        let Some(sites) = collect_group_return_sites(entries, sf) else {
            continue;
        };
        let is_error_builder = entries.len() == 1
            && candidate_function_name(first_entry.fn_node, first_entry.candidate_node)
                .is_some_and(is_error_or_failure_function_name);
        for (field_name, const_lit, prop_node) in &sites[0].ordered_boolean_fields {
            if is_error_builder && *const_lit == "false" {
                continue;
            }
            let all_same = sites.iter().skip(1).all(|site| {
                site.fields
                    .get(field_name)
                    .is_some_and(|(other_lit, _)| *other_lit == Some(*const_lit))
            });
            if all_same
                && is_wide_non_optional_boolean_property(
                    checker,
                    target_type,
                    first_entry.contract_type_node,
                    field_name,
                )
            {
                violations.push(ConstantReturnFieldViolation {
                    report_node: *prop_node,
                    contract_name: first_entry.contract_label.clone(),
                    field_name: field_name.clone(),
                    constant_literal: const_lit,
                });
            }
        }
    }
    violations
}
