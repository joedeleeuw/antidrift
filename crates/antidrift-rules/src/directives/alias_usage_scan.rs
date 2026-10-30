use antidrift_kernel::tsrs_kernel::unwrap_expression;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub(super) fn is_loop_node(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::ForStatement
            | Kind::ForOfStatement
            | Kind::ForInStatement
            | Kind::WhileStatement
            | Kind::DoStatement
    )
}

pub(super) fn is_function_boundary(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::FunctionDeclaration
            | Kind::FunctionExpression
            | Kind::ArrowFunction
            | Kind::MethodDeclaration
            | Kind::GetAccessor
            | Kind::SetAccessor
            | Kind::Constructor
    )
}

fn is_assignment_operator(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::EqualsToken
            | Kind::PlusEqualsToken
            | Kind::MinusEqualsToken
            | Kind::AsteriskEqualsToken
            | Kind::SlashEqualsToken
            | Kind::PercentEqualsToken
            | Kind::QuestionQuestionEqualsToken
            | Kind::BarBarEqualsToken
            | Kind::AmpersandAmpersandEqualsToken
    )
}

fn is_mutation_of(node: P<Node>, target_name: &str) -> bool {
    if node.kind() == Kind::BinaryExpression {
        let bin = node.as_binary_expression();
        if is_assignment_operator(bin.operator_token().kind()) {
            let left = unwrap_expression(bin.left());
            return ast::is_identifier(left) && left.as_identifier().text() == target_name;
        }
    }
    if node.kind() == Kind::PrefixUnaryExpression {
        let pre = node.as_prefix_unary_expression();
        let operand = unwrap_expression(pre.operand());
        return matches!(pre.operator(), Kind::PlusPlusToken | Kind::MinusMinusToken)
            && ast::is_identifier(operand)
            && operand.as_identifier().text() == target_name;
    }
    if node.kind() == Kind::PostfixUnaryExpression {
        let post = node.as_postfix_unary_expression();
        let operand = unwrap_expression(post.operand());
        return matches!(post.operator(), Kind::PlusPlusToken | Kind::MinusMinusToken)
            && ast::is_identifier(operand)
            && operand.as_identifier().text() == target_name;
    }
    false
}

pub(super) fn has_branch_mutation(stmts: &[P<Node>], target_name: &str) -> bool {
    stmts.iter().any(|&stmt| {
        let mut found = false;
        visit_mutations(stmt, target_name, false, true, &mut found);
        found
    })
}

pub(super) fn has_loop_mutation(stmts: &[P<Node>], target_name: &str) -> bool {
    stmts.iter().any(|&stmt| {
        let mut found = false;
        visit_loop_mutations(stmt, target_name, false, &mut found);
        found
    })
}

pub(super) fn has_any_mutation(stmts: &[P<Node>], target_name: &str) -> bool {
    stmts.iter().any(|&stmt| {
        let mut found = false;
        visit_mutations(stmt, target_name, true, false, &mut found);
        found
    })
}

fn visit_mutations(
    node: P<Node>,
    target_name: &str,
    cross_functions: bool,
    skip_loops: bool,
    found: &mut bool,
) {
    if *found
        || (!cross_functions && is_function_boundary(node))
        || (skip_loops && is_loop_node(node))
    {
        return;
    }
    if is_mutation_of(node, target_name) {
        *found = true;
        return;
    }
    node.for_each_child(&mut |child| {
        visit_mutations(child, target_name, cross_functions, skip_loops, found);
        *found
    });
}

fn visit_loop_mutations(node: P<Node>, target_name: &str, in_loop: bool, found: &mut bool) {
    if *found || is_function_boundary(node) {
        return;
    }
    let next_in_loop = in_loop || is_loop_node(node);
    if next_in_loop && is_mutation_of(node, target_name) {
        *found = true;
        return;
    }
    node.for_each_child(&mut |child| {
        visit_loop_mutations(child, target_name, next_in_loop, found);
        *found
    });
}

pub(super) fn has_memo_cache_store(stmts: &[P<Node>], target_name: &str) -> bool {
    let mut found = false;
    for &stmt in stmts {
        visit_memo_cache_store(stmt, target_name, &mut found);
        if found {
            return true;
        }
    }
    false
}

fn is_memo_cache_store(node: P<Node>, target_name: &str) -> bool {
    if node.kind() != Kind::BinaryExpression {
        return false;
    }
    let bin = node.as_binary_expression();
    if bin.operator_token().kind() != Kind::EqualsToken {
        return false;
    }
    let left = unwrap_expression(bin.left());
    let right = unwrap_expression(bin.right());
    if left.kind() != Kind::ElementAccessExpression
        || !ast::is_identifier(right)
        || right.as_identifier().text() != target_name
    {
        return false;
    }
    let obj = unwrap_expression(left.as_element_access_expression().expression());
    ast::is_identifier(obj) && obj.as_identifier().text() == "$"
}

fn visit_memo_cache_store(node: P<Node>, target_name: &str, found: &mut bool) {
    if *found || is_function_boundary(node) {
        return;
    }
    if is_memo_cache_store(node, target_name) {
        *found = true;
        return;
    }
    node.for_each_child(&mut |child| {
        visit_memo_cache_store(child, target_name, found);
        *found
    });
}

pub(super) fn is_immediate_return(next_stmt: Option<P<Node>>, target_name: &str) -> bool {
    let Some(stmt) = next_stmt else {
        return false;
    };
    if stmt.kind() != Kind::ReturnStatement {
        return false;
    }
    let Some(expr) = stmt.as_return_statement().expression() else {
        return false;
    };
    let unwrapped = unwrap_expression(expr);
    ast::is_identifier(unwrapped) && unwrapped.as_identifier().text() == target_name
}

pub(super) fn has_identifier_read(stmts: &[P<Node>], target_name: &str) -> bool {
    let mut found = false;
    for &stmt in stmts {
        visit_identifier_read(stmt, target_name, &mut found);
        if found {
            return true;
        }
    }
    false
}

fn visit_identifier_read(node: P<Node>, target_name: &str, found: &mut bool) {
    if *found {
        return;
    }
    if ast::is_identifier(node) && node.as_identifier().text() == target_name {
        let is_prop_name = node.parent().is_some_and(|parent| {
            parent.kind() == Kind::PropertyAccessExpression
                && parent.as_property_access_expression().name() == node
        });
        if !is_prop_name {
            *found = true;
            return;
        }
    }
    node.for_each_child(&mut |child| {
        visit_identifier_read(child, target_name, found);
        *found
    });
}

pub(super) fn has_equality_comparison(root: P<Node>, x_name: &str, y_name: &str) -> bool {
    let mut found = false;
    visit_equality_comparison(root, x_name, y_name, &mut found);
    found
}

fn is_equality_pair_comparison(node: P<Node>, x_name: &str, y_name: &str) -> bool {
    if node.kind() != Kind::BinaryExpression {
        return false;
    }
    let bin = node.as_binary_expression();
    if !matches!(
        bin.operator_token().kind(),
        Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken
    ) {
        return false;
    }
    let left = unwrap_expression(bin.left());
    let right = unwrap_expression(bin.right());
    if !ast::is_identifier(left) || !ast::is_identifier(right) {
        return false;
    }
    let l = left.as_identifier().text();
    let r = right.as_identifier().text();
    (l == x_name && r == y_name) || (l == y_name && r == x_name)
}

fn visit_equality_comparison(node: P<Node>, x_name: &str, y_name: &str, found: &mut bool) {
    if *found {
        return;
    }
    if is_equality_pair_comparison(node, x_name, y_name) {
        *found = true;
        return;
    }
    node.for_each_child(&mut |child| {
        visit_equality_comparison(child, x_name, y_name, found);
        *found
    });
}
