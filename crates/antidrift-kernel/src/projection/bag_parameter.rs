use rustc_hash::FxHashSet;
use tsrs_ast::{
    self as ast, BindingElement, Kind, Node, NodeFlags, SourceFile, Symbol, VariableDeclaration,
};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::projection::bag_state::{
    BagState, inspect_bag_value_expression, is_bag_object_reference, is_empty_object_fallback,
    is_nullish_expression, is_pure_bag_condition, is_static_scalar_literal,
};
use crate::{provenance, shape, tsrs_kernel};

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
            parameter_name: name_node.as_identifier().text().to_owned(),
            parameter_node: Some(param_node),
            root_symbols: FxHashSet::from_iter([root_sym]),
            field_symbols: FxHashSet::default(),
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
        root_symbols: FxHashSet::default(),
        field_symbols,
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
            && collect_binding_pattern_symbols(name_node, checker, &mut bag_state.field_symbols);
    }
    ast::is_identifier(name_node)
        && inspect_bag_value_expression(init, bag_state, checker).reads_bag_field()
        && provenance::symbol_at_node(checker, name_node).is_some_and(|local_sym| {
            bag_state.field_symbols.insert(local_sym);
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
