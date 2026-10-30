use tsrs_ast::{self as ast, Kind, Node, SourceFile, SymbolFlags, TypeReferenceNode};
use tsrs_checker::{Checker, Type};
use tsrs_core::P;
use tsrslint::utils::{find_modifier, get_call_signatures, is_object_type, is_union_type};

use crate::projection::bag_parameter::{
    collect_return_expressions_from_expression, collect_statement_return_expressions,
    resolve_bag_parameter,
};
use crate::projection::bag_projection::{
    BagProjectionOptions, inspect_object_literal_bag_projection_with_options,
};
use crate::projection::bag_state::BagState;
use crate::{provenance, tsrs_kernel, type_syntax};

const ANONYMOUS_UTILITY_TYPE_NAMES: &[&str] =
    &["Omit", "Partial", "Pick", "Readonly", "Record", "Required"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BagReshaperClassification {
    BagToContract {
        parameter_name: String,
        target_contract: String,
    },
    BagToBag {
        parameter_name: String,
    },
}

fn named_contract_from_type_reference(
    type_node: P<Node>,
    type_ref: &TypeReferenceNode,
    sf: P<SourceFile>,
) -> Option<String> {
    let type_name = tsrs_kernel::node_text(sf, type_ref.type_name()).trim();
    if type_name == "Record" {
        return None;
    }
    if ANONYMOUS_UTILITY_TYPE_NAMES.contains(&type_name)
        && let Some(args) = type_ref.type_arguments()
        && args.nodes().len() == 1
        && args.nodes()[0].kind() == Kind::TypeLiteral
    {
        return None;
    }
    let text = tsrs_kernel::node_text(sf, type_node).trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn named_contract_from_type_node(type_node: Option<P<Node>>, sf: P<SourceFile>) -> Option<String> {
    let node = type_node?;
    match node.kind() {
        Kind::ParenthesizedType => {
            named_contract_from_type_node(Some(node.as_parenthesized_type_node().type_()), sf)
        }
        Kind::TypeReference => {
            named_contract_from_type_reference(node, node.as_type_reference_node(), sf)
        }
        Kind::IndexedAccessType => {
            let text = tsrs_kernel::node_text(sf, node).trim();
            (!text.is_empty()).then(|| text.to_owned())
        }
        Kind::UnionType | Kind::IntersectionType => {
            tsrs_kernel::union_or_intersection_type_nodes(node)
                .iter()
                .copied()
                .filter(|&part| !type_syntax::is_empty_union_branch(part))
                .find_map(|part| named_contract_from_type_node(Some(part), sf))
        }
        _ => None,
    }
}

fn explicit_type_node_on_expression(mut current: P<Node>) -> Option<P<Node>> {
    while ast::is_parenthesized_expression(current) {
        current = current.as_parenthesized_expression().expression();
    }
    match current.kind() {
        Kind::AsExpression => Some(current.as_as_expression().type_()),
        Kind::SatisfiesExpression => Some(current.as_satisfies_expression().type_()),
        _ => None,
    }
}

fn container_return_type_node(container_node: P<Node>) -> Option<P<Node>> {
    let type_node = match container_node.kind() {
        Kind::VariableDeclaration => container_node.as_variable_declaration().type_(),
        Kind::PropertyDeclaration => container_node.as_property_declaration().type_(),
        _ => None,
    }?;
    (type_node.kind() == Kind::FunctionType).then(|| type_node.as_function_type_node().type_())?
}

fn is_sync_non_generator_function(function_node: P<Node>) -> bool {
    tsrs_kernel::function_body_node(function_node).is_some()
        && !tsrs_kernel::is_generator_function(function_node)
        && find_modifier(function_node, Kind::AsyncKeyword).is_none()
}

fn collect_function_bag_returns(
    body: P<Node>,
    bag_param: &mut BagState,
    checker: &mut Checker,
) -> Option<Vec<P<Node>>> {
    let mut return_expressions = Vec::new();
    let ok = if ast::is_block(body) {
        collect_statement_return_expressions(body, bag_param, checker, &mut return_expressions)
    } else {
        collect_return_expressions_from_expression(Some(body), &mut return_expressions)
    };
    ok.then_some(return_expressions)
}

fn row_contract_return_type(checker: &mut Checker, container_node: P<Node>) -> Option<P<Type>> {
    if container_node.kind() != Kind::PropertyAssignment {
        return None;
    }
    let table_literal = container_node
        .parent()
        .filter(|&n| ast::is_object_literal_expression(n))?;
    let table_expr = table_literal.parent().filter(|&n| {
        n.kind() == Kind::SatisfiesExpression
            && n.as_satisfies_expression().expression() == table_literal
    })?;
    let row_key = tsrs_kernel::property_name_text(container_node.as_property_assignment().name())?;
    let table_type = checker.get_type_from_type_node(table_expr.as_satisfies_expression().type_());
    let row_sym = checker.get_property_of_type_exported(table_type, row_key)?;
    let row_type = checker.get_type_of_symbol_at_location(row_sym, Some(container_node))?;
    let &sig = get_call_signatures(checker, row_type).first()?;
    Some(checker.get_return_type_of_signature(sig))
}

fn named_contract_from_type(checker: &mut Checker, typ: P<Type>) -> Option<String> {
    let defined = checker.get_non_nullable_type(typ);
    if let Some(alias) = defined.alias()
        && let Some(alias_sym) = alias.symbol()
    {
        let alias_args = alias.type_arguments();
        let is_anon_util = ANONYMOUS_UTILITY_TYPE_NAMES.contains(&alias_sym.name())
            && alias_args.len() == 1
            && alias_args[0].alias().is_none()
            && is_object_type(alias_args[0])
            && provenance::type_symbol(alias_args[0]).is_some_and(|s| s.name() == "__type");
        if alias_sym.name() == "Record" || is_anon_util {
            return None;
        }
        return Some(checker.type_to_string_exported(defined));
    }
    if is_union_type(defined) {
        return defined
            .types()
            .iter()
            .find_map(|&member| named_contract_from_type(checker, member));
    }
    provenance::type_symbol(defined)
        .filter(|sym| {
            sym.flags
                .get()
                .intersects(SymbolFlags::Interface | SymbolFlags::Class)
        })
        .map(|_| checker.type_to_string_exported(defined))
}

fn is_discriminant_literal(
    checker: &mut Checker,
    union_members: &[P<Type>],
    prop: P<Node>,
) -> bool {
    if prop.kind() != Kind::PropertyAssignment {
        return false;
    }
    let pa = prop.as_property_assignment();
    let Some(disc_name) = tsrs_kernel::property_name_text(pa.name()) else {
        return false;
    };
    let init = tsrs_kernel::unwrap_expression(pa.initializer());
    if !matches!(
        init.kind(),
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral | Kind::NumericLiteral
    ) {
        return false;
    }
    let init_type = checker.get_type_at_location(init);
    union_members.iter().any(|&member| {
        checker
            .get_property_of_type_exported(member, disc_name)
            .and_then(|sym| checker.get_type_of_symbol_at_location(sym, Some(init)))
            .is_some_and(|prop_type| {
                (prop_type.is_string_literal() || prop_type.is_number_literal())
                    && checker.is_type_assignable_to(init_type, prop_type)
            })
    })
}

fn passes_parameter_field_unchanged(
    checker: &mut Checker,
    parameter_node: P<Node>,
    prop: P<Node>,
) -> bool {
    let param_name = parameter_node.as_parameter_declaration().name();
    if prop.kind() == Kind::ShorthandPropertyAssignment {
        let shorthand = prop.as_shorthand_property_assignment();
        return shorthand.object_assignment_initializer().is_none()
            && provenance::symbol_at_node(checker, shorthand.name())
                .and_then(|sym| sym.value_declaration())
                .is_some_and(|decl| {
                    decl.kind() == Kind::BindingElement
                        && decl.parent() == Some(param_name)
                        && decl.as_binding_element().property_name().is_none()
                        && decl.as_binding_element().initializer().is_none()
                });
    }
    if prop.kind() != Kind::PropertyAssignment || !ast::is_identifier(param_name) {
        return false;
    }
    let pa = prop.as_property_assignment();
    let field_read = tsrs_kernel::unwrap_expression(pa.initializer());
    if field_read.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = field_read.as_property_access_expression();
    tsrs_kernel::property_name_text(access.name()) == tsrs_kernel::property_name_text(pa.name())
        && ast::is_identifier(access.expression())
        && provenance::symbol_at_node(checker, access.expression())
            == provenance::symbol_at_node(checker, param_name)
}

fn tags_union_member_with_parameter_fields(
    checker: &mut Checker,
    contract_return_type: P<Type>,
    parameter_node: P<Node>,
    return_expressions: &[P<Node>],
) -> bool {
    if !is_union_type(contract_return_type) {
        return false;
    }
    let union_members: Vec<P<Type>> = contract_return_type
        .types()
        .iter()
        .copied()
        .filter(|&member| is_object_type(member))
        .collect();
    if union_members.len() < 2 {
        return false;
    }
    return_expressions.iter().all(|&ret_expr| {
        let obj = tsrs_kernel::unwrap_expression(ret_expr);
        if !ast::is_object_literal_expression(obj) {
            return false;
        }
        let props = obj.as_object_literal_expression().properties().nodes();
        let disc_count = props
            .iter()
            .filter(|&&p| is_discriminant_literal(checker, &union_members, p))
            .count();
        disc_count == 1
            && props.iter().all(|&p| {
                is_discriminant_literal(checker, &union_members, p)
                    || passes_parameter_field_unchanged(checker, parameter_node, p)
            })
    })
}

pub fn classify_bag_reshaper(
    function_node: P<Node>,
    container_node: P<Node>,
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> Option<BagReshaperClassification> {
    if !is_sync_non_generator_function(function_node) {
        return None;
    }
    let body = tsrs_kernel::function_body_node(function_node)?;
    let mut bag_param = resolve_bag_parameter(function_node, checker, sf)?;
    let return_expressions = collect_function_bag_returns(body, &mut bag_param, checker)?;
    if return_expressions.is_empty() {
        return None;
    }
    let declared_return_type = tsrs_kernel::function_return_type_node(function_node)
        .or_else(|| container_return_type_node(container_node));
    let row_contract = declared_return_type
        .is_none()
        .then(|| row_contract_return_type(checker, container_node))
        .flatten();
    if let (Some(rc), Some(param_node)) = (row_contract, bag_param.parameter_node)
        && tags_union_member_with_parameter_fields(checker, rc, param_node, &return_expressions)
    {
        return None;
    }
    let mut target_contract = if let Some(rc) = row_contract {
        named_contract_from_type(checker, rc)
    } else {
        named_contract_from_type_node(declared_return_type, sf)
    };
    let options = BagProjectionOptions {
        whole_root_reference_is_envelope: true,
        allow_static_branch: return_expressions.len() > 1,
    };
    for ret_expr in return_expressions {
        if target_contract.is_none()
            && let Some(assertion_type) = explicit_type_node_on_expression(ret_expr)
        {
            target_contract = named_contract_from_type_node(Some(assertion_type), sf);
        }
        let unwrapped_ret = tsrs_kernel::unwrap_expression(ret_expr);
        if !ast::is_object_literal_expression(unwrapped_ret)
            || !inspect_object_literal_bag_projection_with_options(
                unwrapped_ret,
                &bag_param,
                checker,
                options,
            )
        {
            return None;
        }
    }
    if let Some(target_contract) = target_contract {
        return Some(BagReshaperClassification::BagToContract {
            parameter_name: bag_param.parameter_name,
            target_contract,
        });
    }
    Some(BagReshaperClassification::BagToBag {
        parameter_name: bag_param.parameter_name,
    })
}
