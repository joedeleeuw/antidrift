use super::alias_usage_scan::{
    has_any_mutation, has_branch_mutation, has_equality_comparison, has_identifier_read,
    has_loop_mutation, has_memo_cache_store, is_function_boundary, is_immediate_return,
    is_loop_node,
};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::tsrs_kernel::{enclosing_function, unwrap_expression};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-mutable-let-alias";

pub struct NoMutableLetAlias {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoMutableLetAlias = NoMutableLetAlias {
    scope: RuleScope::DEFAULT,
};

impl NoMutableLetAlias {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::Block)];

impl Rule for NoMutableLetAlias {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() != Kind::Block {
            return;
        }
        let Some(fn_node) = enclosing_function(node) else {
            return;
        };
        check_settled_let_const_alias(ctx, node);
        check_staged_let_const_alias(ctx, node, fn_node);
    }
}

fn check_settled_let_const_alias(ctx: &mut Ctx, block: P<Node>) {
    let stmts = block.as_block().statements().nodes();
    let mut let_decls: Vec<(usize, &'static str)> = Vec::new();
    for (idx, &stmt) in stmts.iter().enumerate() {
        collect_let_names_in_stmt(stmt, idx, &mut let_decls);
    }
    if let_decls.is_empty() {
        return;
    }
    for (const_idx, &stmt) in stmts.iter().enumerate() {
        let Some((decl_node, y_name, x_name)) = extract_const_ident_alias(stmt) else {
            continue;
        };
        let Some(&(let_idx, _)) = let_decls
            .iter()
            .rev()
            .find(|&&(idx, name)| idx < const_idx && name == x_name)
        else {
            continue;
        };
        let between = &stmts[let_idx + 1..const_idx];
        let after = &stmts[const_idx + 1..];
        if !has_branch_mutation(between, x_name)
            || has_loop_mutation(between, x_name)
            || has_memo_cache_store(between, x_name)
            || has_any_mutation(after, x_name)
            || is_immediate_return(after.first().copied(), y_name)
            || !has_identifier_read(after, y_name)
        {
            continue;
        }
        ctx.report_node(
            decl_node,
            RuleMessage::new(
                "settledLetConstAlias",
                format!(
                    "Mutable binding '{x_name}' is initialized across branches and then aliased to 'const {y_name} = {x_name}' without further mutation. Extract the initialization into a helper or expression and bind 'const {y_name}' once."
                ),
            ),
        );
    }
}

fn check_staged_let_const_alias(ctx: &mut Ctx, block: P<Node>, fn_node: P<Node>) {
    let stmts = block.as_block().statements().nodes();
    if stmts.len() < 2 {
        return;
    }
    for idx in 0..stmts.len() - 1 {
        let Some((_decl_node, y_name)) = extract_const_non_ident_decl(stmts[idx]) else {
            continue;
        };
        let Some(x_name) = extract_ident_assignment(stmts[idx + 1], y_name) else {
            continue;
        };
        if x_name == y_name || !has_enclosing_let_without_loop(block, idx, fn_node, x_name) {
            continue;
        }
        let after = &stmts[idx + 2..];
        if is_immediate_return(after.first().copied(), y_name)
            || !has_identifier_read(after, y_name)
            || has_equality_comparison(fn_node, x_name, y_name)
        {
            continue;
        }
        ctx.report_node(
            stmts[idx + 1],
            RuleMessage::new(
                "stagedLetConstAlias",
                format!(
                    "Staging 'const {y_name}' only to immediately assign '{x_name} = {y_name}' splits one value across a mutable outer 'let {x_name}' and a local 'const {y_name}' alias. Return the value from a helper or branch expression and bind a single 'const'."
                ),
            ),
        );
    }
}

fn declaration_list_keyword(decl_list: P<Node>) -> Option<Kind> {
    let mut keyword = None;
    decl_list.for_each_child(&mut |child| {
        if matches!(
            child.kind(),
            Kind::ConstKeyword | Kind::LetKeyword | Kind::VarKeyword
        ) {
            keyword = Some(child.kind());
            return true;
        }
        false
    });
    if keyword.is_none() {
        let flags = decl_list.flags();
        if flags.intersects(ast::NodeFlags::Const) {
            return Some(Kind::ConstKeyword);
        }
        if flags.intersects(ast::NodeFlags::Let) {
            return Some(Kind::LetKeyword);
        }
    }
    keyword
}

fn collect_let_names_in_stmt(stmt: P<Node>, stmt_idx: usize, out: &mut Vec<(usize, &'static str)>) {
    if stmt.kind() != Kind::VariableStatement {
        return;
    }
    let decl_list = stmt.as_variable_statement().declaration_list();
    if declaration_list_keyword(decl_list) != Some(Kind::LetKeyword) {
        return;
    }
    for &decl in decl_list
        .as_variable_declaration_list()
        .declarations()
        .nodes()
    {
        let name_node = decl.as_variable_declaration().name();
        if ast::is_identifier(name_node) {
            out.push((stmt_idx, name_node.as_identifier().text()));
        }
    }
}

fn single_const_decl(stmt: P<Node>) -> Option<(P<Node>, &'static str, P<Node>)> {
    if stmt.kind() != Kind::VariableStatement {
        return None;
    }
    let decl_list = stmt.as_variable_statement().declaration_list();
    if declaration_list_keyword(decl_list) != Some(Kind::ConstKeyword) {
        return None;
    }
    let [decl_node] = decl_list
        .as_variable_declaration_list()
        .declarations()
        .nodes()
    else {
        return None;
    };
    let decl = decl_node.as_variable_declaration();
    let name_node = decl.name();
    let init = unwrap_expression(decl.initializer()?);
    ast::is_identifier(name_node).then(|| (*decl_node, name_node.as_identifier().text(), init))
}

fn extract_const_ident_alias(stmt: P<Node>) -> Option<(P<Node>, &'static str, &'static str)> {
    let (decl_node, y_name, init) = single_const_decl(stmt)?;
    if !ast::is_identifier(init) {
        return None;
    }
    let x_name = init.as_identifier().text();
    (y_name != x_name).then_some((decl_node, y_name, x_name))
}

fn extract_const_non_ident_decl(stmt: P<Node>) -> Option<(P<Node>, &'static str)> {
    let (decl_node, y_name, init) = single_const_decl(stmt)?;
    (!ast::is_identifier(init)).then_some((decl_node, y_name))
}

fn extract_ident_assignment(stmt: P<Node>, expected_rhs: &str) -> Option<&'static str> {
    if stmt.kind() != Kind::ExpressionStatement {
        return None;
    }
    let expr = unwrap_expression(stmt.as_expression_statement().expression());
    if expr.kind() != Kind::BinaryExpression {
        return None;
    }
    let bin = expr.as_binary_expression();
    if bin.operator_token().kind() != Kind::EqualsToken {
        return None;
    }
    let left = unwrap_expression(bin.left());
    let right = unwrap_expression(bin.right());
    if !ast::is_identifier(left) || !ast::is_identifier(right) {
        return None;
    }
    (right.as_identifier().text() == expected_rhs).then_some(left.as_identifier().text())
}

fn has_enclosing_let_without_loop(
    block: P<Node>,
    max_stmt_idx: usize,
    fn_node: P<Node>,
    target_name: &str,
) -> bool {
    if block_declares_let_before(block, max_stmt_idx, target_name) {
        return true;
    }
    let mut cur = block;
    while cur != fn_node {
        let Some(parent) = cur.parent() else {
            break;
        };
        if is_loop_node(parent) || is_function_boundary(parent) {
            return false;
        }
        if parent.kind() == Kind::Block {
            let stmts = parent.as_block().statements().nodes();
            if let Some(pos) = stmts.iter().position(|&s| s == cur)
                && block_declares_let_before(parent, pos, target_name)
            {
                return true;
            }
        }
        cur = parent;
    }
    false
}

fn block_declares_let_before(block: P<Node>, limit: usize, target_name: &str) -> bool {
    let stmts = block.as_block().statements().nodes();
    let mut let_decls = Vec::new();
    for (idx, &stmt) in stmts.iter().enumerate().take(limit) {
        collect_let_names_in_stmt(stmt, idx, &mut let_decls);
    }
    let_decls.iter().any(|&(_, name)| name == target_name)
}
