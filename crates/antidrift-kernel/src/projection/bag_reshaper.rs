use rustc_hash::FxHashSet;
use tsrs_ast::{
    self as ast, BindingElement, Kind, Node, NodeFlags, SourceFile, Symbol, SymbolFlags,
    TypeReferenceNode, VariableDeclaration,
};
use tsrs_checker::{Checker, Type};
use tsrs_core::P;
use tsrslint::utils::{find_modifier, get_call_signatures, is_object_type, is_union_type};

use crate::projection::bag_state::{
    BagProjectionOptions, BagState, inspect_bag_value_expression,
    inspect_object_literal_bag_projection_with_options, is_bag_object_reference,
    is_empty_object_fallback, is_nullish_expression, is_pure_bag_condition,
    is_static_scalar_literal,
};
use crate::{provenance, shape, tsrs_kernel};

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

fn collect_single_binding_element(
    elem: &BindingElement,
    checker: &mut Checker,
    bucket: &mut FxHashSet<P<Symbol>>,
) -> bool {
    let init_ok = elem
        .initializer()
        .is_none_or(|expr| is_static_scalar_literal(expr) || is_empty_object_fallback(expr));
    if elem.dot_dot_dot_token().is_some() || !init_ok {
        return false;
    }
    let Some(name_node) = elem.name() else {
        return false;
    };
    if ast::is_identifier(name_node) {
        return provenance::symbol_at_node(checker, name_node).is_some_and(|sym| {
            bucket.insert(sym);
            true
        });
    }
    collect_binding_pattern_symbols(name_node, checker, bucket)
}

pub fn collect_binding_pattern_symbols(
    pattern: P<Node>,
    checker: &mut Checker,
    bucket: &mut FxHashSet<P<Symbol>>,
) -> bool {
    pattern.kind() == Kind::ObjectBindingPattern
        && pattern
            .as_binding_pattern()
            .elements()
            .nodes()
            .iter()
            .all(|&elem| collect_single_binding_element(elem.as_binding_element(), checker, bucket))
}

fn build_bag_state_from_name(
    param_node: P<Node>,
    name_node: P<Node>,
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> Option<BagState> {
    if ast::is_identifier(name_node) {
        let root_sym = provenance::symbol_at_node(checker, name_node)?;
        return Some(BagState {
            parameter_name: name_node.as_identifier().text().to_string(),
            parameter_node: Some(param_node),
            bag_root_symbols: FxHashSet::from_iter([root_sym]),
            bag_field_symbols: FxHashSet::default(),
        });
    }
    let mut field_symbols = FxHashSet::default();
    if !collect_binding_pattern_symbols(name_node, checker, &mut field_symbols)
        || field_symbols.is_empty()
    {
        return None;
    }
    let raw_text = tsrs_kernel::node_text(sf, name_node)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some(BagState {
        parameter_name: raw_text,
        parameter_node: Some(param_node),
        bag_root_symbols: FxHashSet::default(),
        bag_field_symbols: field_symbols,
    })
}

pub fn resolve_bag_parameter(
    function_node: P<Node>,
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> Option<BagState> {
    let mut non_this = function_node.parameters().iter().copied().filter(|&param| {
        let name = param.as_parameter_declaration().name();
        !(ast::is_identifier(name) && name.as_identifier().text() == "this")
    });
    let param_node = non_this.next().filter(|_| non_this.next().is_none())?;
    let param = param_node.as_parameter_declaration();
    let name_node = param.name();
    if param.dot_dot_dot_token().is_some() || name_node.kind() == Kind::ArrayBindingPattern {
        return None;
    }
    if param
        .initializer()
        .is_some_and(|init| !is_empty_object_fallback(init) && !is_nullish_expression(init))
    {
        return None;
    }
    let param_type = checker.get_type_at_location(param_node);
    shape::is_plain_bag_type(checker, param_type)
        .then(|| build_bag_state_from_name(param_node, name_node, checker, sf))
        .flatten()
}

pub fn collect_return_expressions_from_expression(
    expr: Option<P<Node>>,
    bucket: &mut Vec<P<Node>>,
) -> bool {
    let Some(expr_node) = expr.filter(|&e| !is_nullish_expression(e)) else {
        return true;
    };
    if ast::is_parenthesized_expression(expr_node) {
        return collect_return_expressions_from_expression(
            Some(expr_node.as_parenthesized_expression().expression()),
            bucket,
        );
    }
    if ast::is_conditional_expression(expr_node) {
        let cond = expr_node.as_conditional_expression();
        return collect_return_expressions_from_expression(Some(cond.when_true()), bucket)
            && collect_return_expressions_from_expression(Some(cond.when_false()), bucket);
    }
    bucket.push(expr_node);
    true
}

fn collect_single_bag_var_decl(
    decl: &VariableDeclaration,
    bag_state: &mut BagState,
    checker: &mut Checker,
) -> bool {
    let Some(init) = decl.initializer() else {
        return false;
    };
    let name_node = decl.name();
    if name_node.kind() == Kind::ObjectBindingPattern {
        return is_bag_object_reference(init, bag_state, checker)
            && collect_binding_pattern_symbols(
                name_node,
                checker,
                &mut bag_state.bag_field_symbols,
            );
    }
    ast::is_identifier(name_node)
        && inspect_bag_value_expression(init, bag_state, checker).reads_bag_field()
        && provenance::symbol_at_node(checker, name_node).is_some_and(|local_sym| {
            bag_state.bag_field_symbols.insert(local_sym);
            true
        })
}

pub fn collect_statement_return_expressions(
    stmt: P<Node>,
    bag_state: &mut BagState,
    checker: &mut Checker,
    bucket: &mut Vec<P<Node>>,
) -> bool {
    match stmt.kind() {
        Kind::Block => {
            stmt.as_block().statements().nodes().iter().all(|&child| {
                collect_statement_return_expressions(child, bag_state, checker, bucket)
            })
        }
        Kind::ReturnStatement => collect_return_expressions_from_expression(
            stmt.as_return_statement().expression(),
            bucket,
        ),
        Kind::IfStatement => {
            let if_stmt = stmt.as_if_statement();
            is_pure_bag_condition(if_stmt.expression(), bag_state, checker)
                && collect_statement_return_expressions(
                    if_stmt.then_statement(),
                    bag_state,
                    checker,
                    bucket,
                )
                && if_stmt.else_statement().is_none_or(|e| {
                    collect_statement_return_expressions(e, bag_state, checker, bucket)
                })
        }
        Kind::VariableStatement => {
            let decl_list = stmt.as_variable_statement().declaration_list();
            decl_list.flags().intersects(NodeFlags::Const)
                && decl_list
                    .as_variable_declaration_list()
                    .declarations()
                    .nodes()
                    .iter()
                    .all(|&d| {
                        collect_single_bag_var_decl(d.as_variable_declaration(), bag_state, checker)
                    })
        }
        _ => false,
    }
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
    (!text.is_empty()).then(|| text.to_string())
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
            (!text.is_empty()).then(|| text.to_string())
        }
        Kind::UnionType | Kind::IntersectionType => {
            tsrs_kernel::union_or_intersection_type_nodes(node)
                .iter()
                .copied()
                .filter(|&part| !shape::is_empty_union_branch(part))
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
