use tsrs_ast::{
    self as ast, Kind, Node, NodeFlags, SourceFile, TypeReferenceNode, VariableDeclaration,
    VariableStatement,
};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::utils::find_modifier;

use crate::projection::bag_state::{
    BagState, collect_binding_pattern_symbols, inspect_bag_value_expression,
    inspect_object_literal_bag_projection, is_bag_object_reference, is_nullish_expression,
    is_pure_bag_condition, resolve_bag_parameter,
};
use crate::{provenance, tsrs_kernel};

const ANONYMOUS_UTILITY_TYPE_NAMES: &[&str] =
    &["Omit", "Partial", "Pick", "Readonly", "Record", "Required"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BagReshaperClassification {
    pub kind: &'static str,
    pub parameter_name: String,
    pub target_contract: String,
}

pub fn collect_return_expressions_from_expression(
    expr: Option<P<Node>>,
    bucket: &mut Vec<P<Node>>,
) -> bool {
    let Some(expr_node) = expr else {
        return true;
    };
    if is_nullish_expression(expr_node) {
        return true;
    }
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
    if ast::is_identifier(name_node) {
        let val_check = inspect_bag_value_expression(init, bag_state, checker);
        if !val_check.valid || !val_check.reads_bag_field {
            return false;
        }
        let Some(local_sym) = provenance::symbol_at_node(checker, name_node) else {
            return false;
        };
        bag_state.bag_field_symbols.insert(local_sym);
        return true;
    }
    false
}

fn collect_variable_statement_bag_bindings(
    vs: &VariableStatement,
    bag_state: &mut BagState,
    checker: &mut Checker,
) -> bool {
    let decl_list = vs.declaration_list();
    if !decl_list.flags().intersects(NodeFlags::Const) {
        return false;
    }
    for &decl_node in decl_list
        .as_variable_declaration_list()
        .declarations()
        .nodes()
    {
        if !collect_single_bag_var_decl(decl_node.as_variable_declaration(), bag_state, checker) {
            return false;
        }
    }
    true
}

pub fn collect_statement_return_expressions(
    stmt: P<Node>,
    bag_state: &mut BagState,
    checker: &mut Checker,
    bucket: &mut Vec<P<Node>>,
) -> bool {
    match stmt.kind() {
        Kind::Block => {
            for &child in stmt.as_block().statements().nodes() {
                if !collect_statement_return_expressions(child, bag_state, checker, bucket) {
                    return false;
                }
            }
            true
        }
        Kind::ReturnStatement => collect_return_expressions_from_expression(
            stmt.as_return_statement().expression(),
            bucket,
        ),
        Kind::IfStatement => {
            let if_stmt = stmt.as_if_statement();
            if !is_pure_bag_condition(if_stmt.expression(), bag_state, checker)
                || !collect_statement_return_expressions(
                    if_stmt.then_statement(),
                    bag_state,
                    checker,
                    bucket,
                )
            {
                return false;
            }
            if let Some(else_stmt) = if_stmt.else_statement() {
                return collect_statement_return_expressions(else_stmt, bag_state, checker, bucket);
            }
            true
        }
        Kind::VariableStatement => collect_variable_statement_bag_bindings(
            stmt.as_variable_statement(),
            bag_state,
            checker,
        ),
        _ => false,
    }
}

fn is_nullish_or_void_member_type_node(part: P<Node>) -> bool {
    if matches!(
        part.kind(),
        Kind::UndefinedKeyword | Kind::NullKeyword | Kind::VoidKeyword
    ) {
        return true;
    }
    part.kind() == Kind::LiteralType
        && part.as_literal_type_node().literal().kind() == Kind::NullKeyword
}

fn named_contract_from_type_reference(
    type_node: P<Node>,
    type_ref: &TypeReferenceNode,
    sf: P<SourceFile>,
) -> String {
    let type_name = tsrs_kernel::node_text(sf, type_ref.type_name()).trim();
    if type_name == "Record" {
        return String::new();
    }
    if ANONYMOUS_UTILITY_TYPE_NAMES.contains(&type_name)
        && let Some(args) = type_ref.type_arguments()
        && args.nodes().len() == 1
        && args.nodes()[0].kind() == Kind::TypeLiteral
    {
        return String::new();
    }
    tsrs_kernel::node_text(sf, type_node).trim().to_string()
}

fn named_contract_from_type_node(type_node: Option<P<Node>>, sf: P<SourceFile>) -> String {
    let Some(node) = type_node else {
        return String::new();
    };
    match node.kind() {
        Kind::ParenthesizedType => {
            named_contract_from_type_node(Some(node.as_parenthesized_type_node().type_()), sf)
        }
        Kind::TypeReference => {
            named_contract_from_type_reference(node, node.as_type_reference_node(), sf)
        }
        Kind::IndexedAccessType => tsrs_kernel::node_text(sf, node).trim().to_string(),
        Kind::UnionType | Kind::IntersectionType => {
            for &part in tsrs_kernel::union_or_intersection_type_nodes(node) {
                if is_nullish_or_void_member_type_node(part) {
                    continue;
                }
                let name = named_contract_from_type_node(Some(part), sf);
                if !name.is_empty() {
                    return name;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn explicit_type_node_on_expression(expr: P<Node>) -> Option<P<Node>> {
    let mut current = expr;
    loop {
        match current.kind() {
            Kind::ParenthesizedExpression => {
                current = current.as_parenthesized_expression().expression();
            }
            Kind::AsExpression => return Some(current.as_as_expression().type_()),
            Kind::SatisfiesExpression => return Some(current.as_satisfies_expression().type_()),
            _ => return None,
        }
    }
}

fn container_return_type_node(container_node: P<Node>) -> Option<P<Node>> {
    let type_node = match container_node.kind() {
        Kind::VariableDeclaration => container_node.as_variable_declaration().type_(),
        Kind::PropertyDeclaration => container_node.as_property_declaration().type_(),
        _ => None,
    }?;
    if type_node.kind() == Kind::FunctionType {
        return type_node.as_function_type_node().type_();
    }
    None
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
    if ok { Some(return_expressions) } else { None }
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
    let mut target_contract = named_contract_from_type_node(declared_return_type, sf);
    for ret_expr in return_expressions {
        if target_contract.is_empty()
            && let Some(assertion_type) = explicit_type_node_on_expression(ret_expr)
        {
            target_contract = named_contract_from_type_node(Some(assertion_type), sf);
        }
        let unwrapped_ret = tsrs_kernel::unwrap_expression(ret_expr);
        if !ast::is_object_literal_expression(unwrapped_ret)
            || !inspect_object_literal_bag_projection(unwrapped_ret, &bag_param, checker)
        {
            return None;
        }
    }
    if !target_contract.is_empty() {
        return Some(BagReshaperClassification {
            kind: "bagToContract",
            parameter_name: bag_param.parameter_name,
            target_contract,
        });
    }
    Some(BagReshaperClassification {
        kind: "bagToBag",
        parameter_name: bag_param.parameter_name,
        target_contract: String::new(),
    })
}
