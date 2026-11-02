use antidrift_kernel::{file_role, provenance, shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, Type};
use tsrs_core::P;

use super::erasure_analysis::{erased_unknown_source, is_const_declaration};

#[derive(Clone, Copy)]
struct Guard {
    expr: P<Node>,
    negated: bool,
}

fn skip_parenthesized_type(mut node: P<Node>) -> P<Node> {
    while node.kind() == Kind::ParenthesizedType {
        node = node.as_parenthesized_type_node().type_();
    }
    node
}

fn is_unknown_type_node(type_node: P<Node>) -> bool {
    skip_parenthesized_type(type_node).kind() == Kind::UnknownKeyword
}

fn resolve_in_program_callee(checker: &mut Checker, call_node: P<Node>) -> Option<P<Node>> {
    let callee = tsrs_kernel::unwrap_parentheses(call_node.as_call_expression().expression());
    let sym = provenance::symbol_at_node(checker, callee)?;
    let decl = sym
        .value_declaration()
        .or_else(|| sym.declarations().first().copied())?;
    let sf = ast::get_source_file_of_node(decl)?;
    if file_role::is_declaration_file(sf.file_name()) || sf.file_name().contains("/node_modules/") {
        return None;
    }
    tsrs_kernel::function_node_from_declaration(decl)
}

fn unknown_param_symbol(
    checker: &mut Checker,
    fn_node: P<Node>,
    param_idx: usize,
) -> Option<P<Symbol>> {
    let params = fn_node.function_like_data()?.parameters()?.nodes();
    let param_node = *params.get(param_idx)?;
    let param = param_node.as_parameter_declaration();
    if param.dot_dot_dot_token().is_some() || !param.type_().is_some_and(is_unknown_type_node) {
        return None;
    }
    let name = param.name();
    ast::is_identifier(name).then(|| checker.get_symbol_at_location_exported(name))?
}

fn is_param_ident(checker: &mut Checker, node: P<Node>, param_sym: P<Symbol>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_parentheses(node);
    ast::is_identifier(unwrapped)
        && checker.get_symbol_at_location_exported(unwrapped) == Some(param_sym)
}

fn is_typeof_param_eq_literal(
    checker: &mut Checker,
    left: P<Node>,
    right: P<Node>,
    param_sym: P<Symbol>,
) -> bool {
    let left = tsrs_kernel::unwrap_parentheses(left);
    let right = tsrs_kernel::unwrap_parentheses(right);
    left.kind() == Kind::TypeOfExpression
        && is_param_ident(
            checker,
            left.as_type_of_expression().expression(),
            param_sym,
        )
        && matches!(
            right.kind(),
            Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
        )
}

fn is_null_or_undefined_node(node: P<Node>) -> bool {
    let n = tsrs_kernel::unwrap_parentheses(node);
    n.kind() == Kind::NullKeyword
        || (ast::is_identifier(n) && n.as_identifier().text() == "undefined")
}

fn is_param_nullish_cmp(
    checker: &mut Checker,
    left: P<Node>,
    right: P<Node>,
    param_sym: P<Symbol>,
) -> bool {
    (is_param_ident(checker, left, param_sym) && is_null_or_undefined_node(right))
        || (is_param_ident(checker, right, param_sym) && is_null_or_undefined_node(left))
}

fn single_param_symbol(checker: &mut Checker, fn_node: P<Node>) -> Option<P<Symbol>> {
    let params = fn_node.function_like_data()?.parameters()?.nodes();
    if params.len() != 1 {
        return None;
    }
    let param = params[0].as_parameter_declaration();
    if param.dot_dot_dot_token().is_some() {
        return None;
    }
    let name = param.name();
    ast::is_identifier(name).then(|| checker.get_symbol_at_location_exported(name))?
}

fn is_type_predicate_call_on_param(
    checker: &mut Checker,
    call_node: P<Node>,
    param_sym: P<Symbol>,
    depth: usize,
) -> bool {
    let call = call_node.as_call_expression();
    let args = call.arguments().nodes();
    if args.len() != 1 || !is_param_ident(checker, args[0], param_sym) {
        return false;
    }
    let callee = tsrs_kernel::unwrap_parentheses(call.expression());
    if callee.kind() == Kind::PropertyAccessExpression {
        let prop = callee.as_property_access_expression();
        let obj = tsrs_kernel::unwrap_parentheses(prop.expression());
        if ast::is_identifier(obj)
            && obj.as_identifier().text() == "Array"
            && ast::is_identifier(prop.name())
            && prop.name().as_identifier().text() == "isArray"
        {
            return true;
        }
    }
    let Some(pred_fn) = resolve_in_program_callee(checker, call_node) else {
        return false;
    };
    if !tsrs_kernel::function_return_type_node(pred_fn)
        .is_some_and(|ret| ret.kind() == Kind::TypePredicate)
    {
        return false;
    }
    let Some(pred_param_sym) = single_param_symbol(checker, pred_fn) else {
        return false;
    };
    let Some(pred_body) = tsrs_kernel::function_body_node(pred_fn) else {
        return false;
    };
    if pred_body.kind() != Kind::Block {
        return is_pure_type_test(checker, pred_body, pred_param_sym, false, depth + 1);
    }
    let [stmt] = pred_body.as_block().statements().nodes() else {
        return false;
    };
    stmt.kind() == Kind::ReturnStatement
        && stmt
            .as_return_statement()
            .expression()
            .is_some_and(|expr| is_pure_type_test(checker, expr, pred_param_sym, false, depth + 1))
}

fn is_pure_type_test(
    checker: &mut Checker,
    expr: P<Node>,
    param_sym: P<Symbol>,
    negated: bool,
    depth: usize,
) -> bool {
    if depth > 4 {
        return false;
    }
    let node = tsrs_kernel::unwrap_parentheses(expr);
    match node.kind() {
        Kind::PrefixUnaryExpression => {
            let prefix = node.as_prefix_unary_expression();
            prefix.operator() == Kind::ExclamationToken
                && is_pure_type_test(checker, prefix.operand(), param_sym, !negated, depth)
        }
        Kind::BinaryExpression => {
            let bin = node.as_binary_expression();
            let op = bin.operator_token().kind();
            if matches!(op, Kind::AmpersandAmpersandToken | Kind::BarBarToken) {
                return is_pure_type_test(checker, bin.left(), param_sym, negated, depth)
                    && is_pure_type_test(checker, bin.right(), param_sym, negated, depth);
            }
            if op == Kind::InstanceOfKeyword && !negated {
                return is_param_ident(checker, bin.left(), param_sym);
            }
            if matches!(
                op,
                Kind::EqualsEqualsEqualsToken
                    | Kind::EqualsEqualsToken
                    | Kind::ExclamationEqualsEqualsToken
                    | Kind::ExclamationEqualsToken
            ) {
                return is_typeof_param_eq_literal(checker, bin.left(), bin.right(), param_sym)
                    || is_typeof_param_eq_literal(checker, bin.right(), bin.left(), param_sym)
                    || is_param_nullish_cmp(checker, bin.left(), bin.right(), param_sym);
            }
            false
        }
        Kind::CallExpression => is_type_predicate_call_on_param(checker, node, param_sym, depth),
        _ => false,
    }
}

fn statement_definitely_exits(stmt: P<Node>) -> bool {
    match stmt.kind() {
        Kind::ReturnStatement | Kind::ThrowStatement => true,
        Kind::Block => stmt
            .as_block()
            .statements()
            .nodes()
            .last()
            .is_some_and(|&last| statement_definitely_exits(last)),
        _ => false,
    }
}

fn collect_preceding_block_guards(
    block: P<Node>,
    current: P<Node>,
    guards: &mut Vec<Guard>,
) -> bool {
    for &stmt in block.as_block().statements().nodes() {
        if stmt == current {
            return true;
        }
        if stmt.kind() != Kind::IfStatement {
            return false;
        }
        let if_stmt = stmt.as_if_statement();
        if if_stmt.else_statement().is_some()
            || !statement_definitely_exits(if_stmt.then_statement())
        {
            return false;
        }
        guards.push(Guard {
            expr: if_stmt.expression(),
            negated: true,
        });
    }
    true
}

fn collect_statement_guards(ret_stmt: P<Node>, fn_body: P<Node>) -> Option<Vec<Guard>> {
    let mut guards = Vec::new();
    let mut current = ret_stmt;
    while current != fn_body {
        let parent = current.parent()?;
        match parent.kind() {
            Kind::IfStatement => {
                let if_stmt = parent.as_if_statement();
                let negated = if_stmt.then_statement() != current;
                guards.push(Guard {
                    expr: if_stmt.expression(),
                    negated,
                });
            }
            Kind::Block if collect_preceding_block_guards(parent, current, &mut guards) => {}
            _ => return None,
        }
        current = parent;
    }
    Some(guards)
}

fn expr_returns_satisfied_param(
    checker: &mut Checker,
    expr: P<Node>,
    param_sym: P<Symbol>,
    arg_type: P<Type>,
    guards: &[Guard],
) -> bool {
    let unwrapped = tsrs_kernel::unwrap_parentheses(expr);
    if unwrapped.kind() == Kind::ConditionalExpression {
        let cond = unwrapped.as_conditional_expression();
        let mut true_guards = guards.to_vec();
        true_guards.push(Guard {
            expr: cond.condition(),
            negated: false,
        });
        let mut false_guards = guards.to_vec();
        false_guards.push(Guard {
            expr: cond.condition(),
            negated: true,
        });
        return expr_returns_satisfied_param(
            checker,
            cond.when_true(),
            param_sym,
            arg_type,
            &true_guards,
        ) || expr_returns_satisfied_param(
            checker,
            cond.when_false(),
            param_sym,
            arg_type,
            &false_guards,
        );
    }
    if !is_param_ident(checker, unwrapped, param_sym) || guards.is_empty() {
        return false;
    }
    if !guards
        .iter()
        .all(|g| is_pure_type_test(checker, g.expr, param_sym, g.negated, 0))
    {
        return false;
    }
    let narrowed_type = checker.get_type_at_location(unwrapped);
    shape::is_specific_type(narrowed_type) && checker.is_type_assignable_to(arg_type, narrowed_type)
}

fn walk_returns(
    checker: &mut Checker,
    node: P<Node>,
    fn_node: P<Node>,
    param_sym: P<Symbol>,
    arg_type: P<Type>,
) -> bool {
    if node.kind() == Kind::ReturnStatement
        && tsrs_kernel::enclosing_function(node) == Some(fn_node)
        && let Some(fn_body) = tsrs_kernel::function_body_node(fn_node)
        && let Some(expr) = node.as_return_statement().expression()
        && let Some(guards) = collect_statement_guards(node, fn_body)
        && expr_returns_satisfied_param(checker, expr, param_sym, arg_type, &guards)
    {
        return true;
    }
    let mut matched = false;
    node.for_each_child(&mut |child| {
        if !matched && walk_returns(checker, child, fn_node, param_sym, arg_type) {
            matched = true;
        }
        matched
    });
    matched
}

fn fn_narrows_already_satisfied_param(
    checker: &mut Checker,
    fn_node: P<Node>,
    param_sym: P<Symbol>,
    arg_type: P<Type>,
) -> bool {
    let Some(body) = tsrs_kernel::function_body_node(fn_node) else {
        return false;
    };
    if body.kind() != Kind::Block {
        return expr_returns_satisfied_param(checker, body, param_sym, arg_type, &[]);
    }
    walk_returns(checker, body, fn_node, param_sym, arg_type)
}

pub fn call_arg_narrows_satisfied_type(
    checker: &mut Checker,
    call_node: P<Node>,
    arg_node: P<Node>,
    arg_type: P<Type>,
) -> bool {
    if !shape::is_specific_type(arg_type) {
        return false;
    }
    let args = call_node.as_call_expression().arguments().nodes();
    let Some(arg_idx) = args.iter().position(|&a| {
        tsrs_kernel::unwrap_parentheses(a) == tsrs_kernel::unwrap_parentheses(arg_node)
    }) else {
        return false;
    };
    let Some(fn_node) = resolve_in_program_callee(checker, call_node) else {
        return false;
    };
    let Some(param_sym) = unknown_param_symbol(checker, fn_node, arg_idx) else {
        return false;
    };
    fn_narrows_already_satisfied_param(checker, fn_node, param_sym, arg_type)
}

pub fn find_redundant_unknown_call_arg(
    checker: &mut Checker,
    call_node: P<Node>,
) -> Option<P<Node>> {
    let args = call_node.as_call_expression().arguments().nodes();
    let fn_node = resolve_in_program_callee(checker, call_node)?;
    for (idx, &arg) in args.iter().enumerate() {
        let Some(param_sym) = unknown_param_symbol(checker, fn_node, idx) else {
            continue;
        };
        let unwrapped = tsrs_kernel::unwrap_parentheses(arg);
        if ast::is_identifier(unwrapped)
            && let Some(decl) = checker
                .get_symbol_at_location_exported(unwrapped)
                .and_then(|sym| sym.value_declaration())
            && decl.kind() == Kind::VariableDeclaration
            && is_const_declaration(decl)
            && let Some(init) = decl.as_variable_declaration().initializer()
            && erased_unknown_source(decl.as_variable_declaration().type_(), init).is_some()
        {
            continue;
        }
        let source_expr = match tsrs_kernel::assertion_parts(unwrapped) {
            Some((operand, cast_type)) if is_unknown_type_node(cast_type) => {
                tsrs_kernel::unwrap_parentheses(operand)
            }
            _ => unwrapped,
        };
        let arg_type = checker.get_type_at_location(source_expr);
        if shape::is_specific_type(arg_type)
            && fn_narrows_already_satisfied_param(checker, fn_node, param_sym, arg_type)
        {
            return Some(arg);
        }
    }
    None
}
