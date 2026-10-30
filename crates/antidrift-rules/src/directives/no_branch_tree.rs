use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::tsrs_kernel::{
    cooked_text, node_text, unwrap_awaited_expression, unwrap_expression,
};
use rustc_hash::FxHashSet;
use std::collections::BTreeMap;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-branch-tree";

pub struct NoBranchTree {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoBranchTree = NoBranchTree {
    scope: RuleScope::DEFAULT,
};

impl NoBranchTree {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::IfStatement),
    Listener::Enter(Kind::Block),
];

impl Rule for NoBranchTree {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            checked_source_file: false,
        })
    }
}

struct Visitor {
    checked_source_file: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if !self.checked_source_file {
            self.checked_source_file = true;
            check_negated_discriminant_scatter(ctx, ctx.file.as_node());
        }
        if node.kind() == Kind::IfStatement {
            check_subject_coupled_branch_tree(ctx, node);
        } else {
            check_negated_discriminant_scatter(ctx, node);
        }
    }
}

fn check_subject_coupled_branch_tree(ctx: &mut Ctx, node: P<Node>) {
    let if_stmt = node.as_if_statement();
    let Some(else_stmt) = if_stmt.else_statement() else {
        return;
    };
    if else_stmt.kind() == Kind::IfStatement {
        return;
    }
    let mut outer_roots = FxHashSet::default();
    collect_root_identifiers(if_stmt.expression(), &mut outer_roots);
    if outer_roots.is_empty() {
        return;
    }
    let then_stmt = if_stmt.then_statement();
    let then_sinks = collect_statement_sinks(ctx.file, then_stmt);
    let else_sinks = collect_statement_sinks(ctx.file, else_stmt);
    if branch_has_coupled_nested_if(ctx.file, then_stmt, &outer_roots, &else_sinks)
        || branch_has_coupled_nested_if(ctx.file, else_stmt, &outer_roots, &then_sinks)
    {
        ctx.report_node(
            node,
            RuleMessage::new(
                "subjectCoupledBranchTree",
                "Flatten this nested if/else decision tree into early guard returns, a switch, or a case table instead of nesting branches and duplicating sinks on the same subject.",
            ),
        );
    }
}

fn branch_has_coupled_nested_if(
    sf: P<SourceFile>,
    branch: P<Node>,
    outer_roots: &FxHashSet<&'static str>,
    opposite_sinks: &FxHashSet<String>,
) -> bool {
    for child_if in direct_child_ifs(branch) {
        if is_guard_if(child_if) || branch_always_exits(child_if) {
            continue;
        }
        let mut child_roots = FxHashSet::default();
        collect_root_identifiers(child_if.as_if_statement().expression(), &mut child_roots);
        if !child_roots.iter().any(|root| outer_roots.contains(root)) {
            continue;
        }
        let child_sinks = collect_statement_sinks(sf, child_if);
        let shares_sink = child_sinks.iter().any(|sink| opposite_sinks.contains(sink));
        if shares_sink || contains_non_template_ternary_on_roots(child_if, outer_roots) {
            return true;
        }
    }
    false
}

fn direct_child_ifs(branch: P<Node>) -> Vec<P<Node>> {
    if branch.kind() == Kind::IfStatement {
        return vec![branch];
    }
    if branch.kind() != Kind::Block {
        return Vec::new();
    }
    branch
        .as_block()
        .statements()
        .nodes()
        .iter()
        .copied()
        .filter(|stmt| stmt.kind() == Kind::IfStatement)
        .collect()
}

fn branch_always_exits(stmt: P<Node>) -> bool {
    match stmt.kind() {
        Kind::ReturnStatement
        | Kind::ThrowStatement
        | Kind::BreakStatement
        | Kind::ContinueStatement => true,
        Kind::Block => stmt
            .as_block()
            .statements()
            .nodes()
            .last()
            .copied()
            .is_some_and(branch_always_exits),
        Kind::IfStatement => {
            let if_stmt = stmt.as_if_statement();
            if_stmt.else_statement().is_some_and(|else_node| {
                branch_always_exits(if_stmt.then_statement()) && branch_always_exits(else_node)
            })
        }
        _ => false,
    }
}

fn is_guard_if(if_node: P<Node>) -> bool {
    let if_stmt = if_node.as_if_statement();
    if_stmt.else_statement().is_none() && branch_always_exits(if_stmt.then_statement())
}

const IGNORED_ROOTS: &[&str] = &[
    "undefined",
    "null",
    "true",
    "false",
    "Math",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
];

fn collect_root_identifiers(node: P<Node>, out: &mut FxHashSet<&'static str>) {
    if ast::is_identifier(node) {
        let is_prop_name = node.parent().is_some_and(|parent| {
            parent.kind() == Kind::PropertyAccessExpression
                && parent.as_property_access_expression().name() == node
        });
        let is_callee = node.parent().is_some_and(|parent| {
            parent.kind() == Kind::CallExpression
                && parent.as_call_expression().expression() == node
        });
        let text = node.as_identifier().text();
        if !is_prop_name && !is_callee && !IGNORED_ROOTS.contains(&text) {
            out.insert(text);
        }
    }
    node.for_each_child(&mut |child| {
        collect_root_identifiers(child, out);
        false
    });
}

const IGNORED_CALL_SINKS: &[&str] = &[
    "console.log",
    "console.error",
    "console.warn",
    "console.info",
    "console.debug",
    "logger.info",
    "logger.warn",
    "logger.error",
    "logger.debug",
    "toast",
    "toast.error",
    "toast.success",
    "toast.info",
    "toast.warning",
    "process.exit",
];

fn is_loop_or_boundary(node: P<Node>) -> bool {
    matches!(
        node.kind(),
        Kind::FunctionDeclaration
            | Kind::FunctionExpression
            | Kind::ArrowFunction
            | Kind::MethodDeclaration
            | Kind::ClassDeclaration
            | Kind::ClassExpression
            | Kind::ForStatement
            | Kind::ForOfStatement
            | Kind::ForInStatement
            | Kind::WhileStatement
            | Kind::DoStatement
    )
}

fn collect_statement_sinks(sf: P<SourceFile>, root: P<Node>) -> FxHashSet<String> {
    let mut sinks = FxHashSet::default();
    visit_statement_sinks(sf, root, &mut sinks);
    sinks
}

fn visit_statement_sinks(sf: P<SourceFile>, node: P<Node>, sinks: &mut FxHashSet<String>) {
    if is_loop_or_boundary(node) {
        return;
    }
    if node.kind() == Kind::ExpressionStatement {
        record_expression_statement_sink(sf, node.as_expression_statement().expression(), sinks);
        return;
    }
    node.for_each_child(&mut |child| {
        visit_statement_sinks(sf, child, sinks);
        false
    });
}

fn record_expression_statement_sink(
    sf: P<SourceFile>,
    expr: P<Node>,
    sinks: &mut FxHashSet<String>,
) {
    let inner = unwrap_awaited_expression(expr);
    if inner.kind() == Kind::BinaryExpression {
        let bin = inner.as_binary_expression();
        if bin.operator_token().kind() == Kind::EqualsToken {
            let lhs = unwrap_expression(bin.left());
            if matches!(
                lhs.kind(),
                Kind::Identifier | Kind::PropertyAccessExpression
            ) {
                sinks.insert(format!("assign:{}", node_text(sf, lhs).trim()));
            }
        }
        return;
    }
    if inner.kind() != Kind::CallExpression {
        return;
    }
    let callee = unwrap_expression(inner.as_call_expression().expression());
    if !matches!(
        callee.kind(),
        Kind::Identifier | Kind::PropertyAccessExpression
    ) {
        return;
    }
    let name = node_text(sf, callee).trim();
    let is_mutation_helper = name.ends_with(".push")
        || name.ends_with(".add")
        || name.ends_with(".set")
        || name.ends_with(".delete")
        || name.starts_with("console.")
        || name.starts_with("logger.");
    if !IGNORED_CALL_SINKS.contains(&name) && !is_mutation_helper {
        sinks.insert(format!("call:{name}"));
    }
}

fn contains_non_template_ternary_on_roots(
    root: P<Node>,
    outer_roots: &FxHashSet<&'static str>,
) -> bool {
    let mut found = false;
    visit_ternary(root, outer_roots, &mut found);
    found
}

fn visit_ternary(node: P<Node>, outer_roots: &FxHashSet<&'static str>, found: &mut bool) {
    if *found || is_loop_or_boundary(node) || node.kind() == Kind::TemplateSpan {
        return;
    }
    if node.kind() == Kind::ConditionalExpression {
        let mut cond_roots = FxHashSet::default();
        collect_root_identifiers(
            node.as_conditional_expression().condition(),
            &mut cond_roots,
        );
        if cond_roots.iter().any(|root| outer_roots.contains(root)) {
            *found = true;
            return;
        }
    }
    node.for_each_child(&mut |child| {
        visit_ternary(child, outer_roots, found);
        *found
    });
}

struct NegatedComparison {
    stmt: P<Node>,
    literal: &'static str,
    is_guard: bool,
}

fn check_negated_discriminant_scatter(ctx: &mut Ctx, container: P<Node>) {
    let stmts: &[P<Node>] = match container.kind() {
        Kind::Block => container.as_block().statements().nodes(),
        Kind::SourceFile => container.as_source_file().statements().nodes(),
        _ => return,
    };
    let mut by_key: BTreeMap<String, Vec<NegatedComparison>> = BTreeMap::new();
    for &stmt in stmts {
        if stmt.kind() != Kind::IfStatement {
            continue;
        }
        let guard = is_guard_if(stmt);
        let mut cmps = Vec::new();
        collect_if_chain_negated_comparisons(ctx.file, stmt, &mut cmps);
        for (key, literal) in cmps {
            by_key.entry(key).or_default().push(NegatedComparison {
                stmt,
                literal,
                is_guard: guard,
            });
        }
    }
    for (key, entries) in by_key {
        let mut distinct_stmts = Vec::new();
        let mut distinct_lits = FxHashSet::default();
        let mut has_non_guard = false;
        for entry in &entries {
            if !distinct_stmts.contains(&entry.stmt) {
                distinct_stmts.push(entry.stmt);
            }
            distinct_lits.insert(entry.literal);
            if !entry.is_guard {
                has_non_guard = true;
            }
        }
        if distinct_stmts.len() >= 2 && distinct_lits.len() >= 2 && has_non_guard {
            ctx.report_node(
                distinct_stmts[1],
                RuleMessage::new(
                    "negatedDiscriminantScatter",
                    format!(
                        "Multiple 'if' statements negate different literal values of '{key}'. Declare the case space once with a switch or lookup table."
                    ),
                ),
            );
        }
    }
}

fn collect_if_chain_negated_comparisons(
    sf: P<SourceFile>,
    if_node: P<Node>,
    out: &mut Vec<(String, &'static str)>,
) {
    let mut cur = Some(if_node);
    while let Some(node) = cur {
        if node.kind() != Kind::IfStatement {
            break;
        }
        let if_stmt = node.as_if_statement();
        collect_negated_prop_comparisons(sf, if_stmt.expression(), out);
        cur = if_stmt.else_statement();
    }
}

fn collect_negated_prop_comparisons(
    sf: P<SourceFile>,
    expr: P<Node>,
    out: &mut Vec<(String, &'static str)>,
) {
    let inner = unwrap_expression(expr);
    if inner.kind() != Kind::BinaryExpression {
        return;
    }
    let bin = inner.as_binary_expression();
    let op = bin.operator_token().kind();
    if matches!(op, Kind::AmpersandAmpersandToken | Kind::BarBarToken) {
        collect_negated_prop_comparisons(sf, bin.left(), out);
        collect_negated_prop_comparisons(sf, bin.right(), out);
        return;
    }
    if op != Kind::ExclamationEqualsEqualsToken {
        return;
    }
    let left = unwrap_expression(bin.left());
    let right = unwrap_expression(bin.right());
    if left.kind() == Kind::PropertyAccessExpression
        && right.kind() == Kind::StringLiteral
        && let Some(literal) = cooked_text(right)
    {
        out.push((node_text(sf, left).trim().to_owned(), literal));
    } else if right.kind() == Kind::PropertyAccessExpression
        && left.kind() == Kind::StringLiteral
        && let Some(literal) = cooked_text(left)
    {
        out.push((node_text(sf, right).trim().to_owned(), literal));
    }
}
