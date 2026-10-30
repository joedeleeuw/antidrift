use antidrift_kernel::callgraph::ProgramSymbolIndex;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{provenance, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-closed-string-parameter";

const BOUNDARY_IDENTIFIERS: &[&str] = &[
    "URLSearchParams",
    "Headers",
    "IncomingHttpHeaders",
    "headers",
];
const BOUNDARY_PROPERTIES: &[&str] = &["argv", "query", "headers"];

pub struct NoClosedStringParameter {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoClosedStringParameter = NoClosedStringParameter {
    scope: RuleScope::DEFAULT,
};

impl NoClosedStringParameter {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
];

impl Rule for NoClosedStringParameter {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.admits_authored_source(ctx) {
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
        check_closed_string_parameters(ctx, node);
        if node.kind() == Kind::FunctionDeclaration {
            check_boolean_flag_parameters(ctx, node);
        }
    }
}

fn parameter_identifier(param: P<Node>, keyword: Kind) -> Option<P<Node>> {
    let decl = param.as_parameter_declaration();
    let name = decl.name();
    (ast::is_identifier(name)
        && decl.dot_dot_dot_token().is_none()
        && decl
            .type_()
            .is_some_and(|type_node| type_node.kind() == keyword))
    .then_some(name)
}

fn is_heritage_class_member(fn_node: P<Node>) -> bool {
    if fn_node.kind() != Kind::MethodDeclaration {
        return false;
    }
    fn_node
        .parent()
        .is_some_and(|class_node| match class_node.kind() {
            Kind::ClassDeclaration => class_node
                .as_class_declaration()
                .heritage_clauses()
                .is_some(),
            Kind::ClassExpression => class_node
                .as_class_expression()
                .heritage_clauses()
                .is_some(),
            _ => false,
        })
}

fn contains_boundary_ast_node(node: P<Node>) -> bool {
    match node.kind() {
        Kind::Identifier => BOUNDARY_IDENTIFIERS.contains(&node.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            tsrs_kernel::property_name_text(node.as_property_access_expression().name())
                .is_some_and(|prop| BOUNDARY_PROPERTIES.contains(&prop))
        }
        _ => {
            let mut found = false;
            node.for_each_child(&mut |child| {
                if contains_boundary_ast_node(child) {
                    found = true;
                    return true;
                }
                false
            });
            found
        }
    }
}

fn is_boundary_decoder(fn_node: P<Node>) -> bool {
    let accepts_unknown = fn_node.parameters().iter().any(|&param| {
        param
            .as_parameter_declaration()
            .type_()
            .is_some_and(|type_node| type_node.kind() == Kind::UnknownKeyword)
    });
    accepts_unknown || contains_boundary_ast_node(fn_node)
}

fn string_literal_count(node: P<Node>) -> usize {
    let inner = tsrs_kernel::unwrap_expression(node);
    match inner.kind() {
        Kind::ArrayLiteralExpression => {
            let elements = inner.as_array_literal_expression().elements().nodes();
            if elements
                .iter()
                .all(|&element| ast::is_string_literal(element))
            {
                elements.len()
            } else {
                0
            }
        }
        Kind::NewExpression => {
            let new_expr = inner.as_new_expression();
            let callee = new_expr.expression();
            let args = new_expr.arguments().map_or(&[][..], |list| list.nodes());
            match args {
                [single]
                    if ast::is_identifier(callee) && callee.as_identifier().text() == "Set" =>
                {
                    string_literal_count(*single)
                }
                _ => 0,
            }
        }
        _ => 0,
    }
}

fn closed_set_size(checker: &mut Checker, receiver: P<Node>) -> usize {
    let inner = tsrs_kernel::unwrap_expression(receiver);
    if !ast::is_identifier(inner) {
        return string_literal_count(inner);
    }
    let Some(decl) =
        provenance::symbol_at_node(checker, inner).and_then(|sym| sym.value_declaration())
    else {
        return 0;
    };
    if decl.kind() != Kind::VariableDeclaration
        || !ast::get_combined_node_flags(decl).intersects(ast::NodeFlags::Const)
    {
        return 0;
    }
    decl.as_variable_declaration()
        .initializer()
        .map_or(0, string_literal_count)
}

fn refers_to(checker: &mut Checker, node: P<Node>, param_symbol: P<Symbol>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(node);
    ast::is_identifier(inner)
        && checker.get_symbol_at_location_exported(inner) == Some(param_symbol)
}

fn is_membership_rejection(checker: &mut Checker, test: P<Node>, param_symbol: P<Symbol>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(test);
    if inner.kind() != Kind::PrefixUnaryExpression {
        return false;
    }
    let prefix = inner.as_prefix_unary_expression();
    let operand = tsrs_kernel::unwrap_expression(prefix.operand());
    if prefix.operator() != Kind::ExclamationToken || operand.kind() != Kind::CallExpression {
        return false;
    }
    let call = operand.as_call_expression();
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    let [argument] = call.arguments().nodes() else {
        return false;
    };
    if callee.kind() != Kind::PropertyAccessExpression
        || !refers_to(checker, *argument, param_symbol)
    {
        return false;
    }
    let access = callee.as_property_access_expression();
    matches!(
        tsrs_kernel::property_name_text(access.name()),
        Some("includes" | "has")
    ) && closed_set_size(checker, access.expression()) >= 2
}

fn inequality_conjunction_size(
    checker: &mut Checker,
    test: P<Node>,
    param_symbol: P<Symbol>,
) -> usize {
    let inner = tsrs_kernel::unwrap_expression(test);
    if inner.kind() != Kind::BinaryExpression {
        return 0;
    }
    let binary = inner.as_binary_expression();
    match binary.operator_token().kind() {
        Kind::AmpersandAmpersandToken => {
            let left = inequality_conjunction_size(checker, binary.left(), param_symbol);
            let right = inequality_conjunction_size(checker, binary.right(), param_symbol);
            if left == 0 || right == 0 {
                0
            } else {
                left + right
            }
        }
        Kind::ExclamationEqualsEqualsToken | Kind::ExclamationEqualsToken => {
            let (left, right) = (binary.left(), binary.right());
            let compares = (refers_to(checker, left, param_symbol)
                && ast::is_string_literal(right))
                || (refers_to(checker, right, param_symbol) && ast::is_string_literal(left));
            usize::from(compares)
        }
        _ => 0,
    }
}

fn is_error_construction(node: P<Node>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(node);
    let callee = match inner.kind() {
        Kind::NewExpression => inner.as_new_expression().expression(),
        Kind::CallExpression => inner.as_call_expression().expression(),
        _ => return false,
    };
    ast::is_identifier(callee) && callee.as_identifier().text().ends_with("Error")
}

fn terminates_with_rejection(statement: P<Node>) -> bool {
    let last = if statement.kind() == Kind::Block {
        statement.as_block().statements().nodes().last().copied()
    } else {
        Some(statement)
    };
    last.is_some_and(|stmt| match stmt.kind() {
        Kind::ThrowStatement => true,
        Kind::ReturnStatement => stmt
            .as_return_statement()
            .expression()
            .is_some_and(is_error_construction),
        _ => false,
    })
}

fn closed_set_guard(checker: &mut Checker, body: P<Node>, param_symbol: P<Symbol>) -> bool {
    if body.kind() != Kind::Block {
        return false;
    }
    body.as_block().statements().nodes().iter().any(|&stmt| {
        if stmt.kind() != Kind::IfStatement {
            return false;
        }
        let if_stmt = stmt.as_if_statement();
        let test = if_stmt.expression();
        terminates_with_rejection(if_stmt.then_statement())
            && (is_membership_rejection(checker, test, param_symbol)
                || inequality_conjunction_size(checker, test, param_symbol) >= 2)
    })
}

fn check_closed_string_parameters(ctx: &mut Ctx, fn_node: P<Node>) {
    let Some(body) = fn_node.body() else {
        return;
    };
    if is_heritage_class_member(fn_node) || is_boundary_decoder(fn_node) {
        return;
    }
    for &param in fn_node.parameters() {
        let Some(name) = parameter_identifier(param, Kind::StringKeyword) else {
            continue;
        };
        let Some(param_symbol) = ctx.checker.get_symbol_at_location_exported(name) else {
            continue;
        };
        if closed_set_guard(ctx.checker, body, param_symbol) {
            let text = name.as_identifier().text();
            ctx.report_node(
                param,
                RuleMessage::new(
                    "closedStringParameter",
                    format!(
                        "'{text}' is typed 'string' but the body rejects every value outside a closed literal set. Type '{text}' as that literal union and decode it once at the boundary."
                    ),
                ),
            );
        }
    }
}

fn is_condition_position(node: P<Node>) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            Kind::ParenthesizedExpression => {}
            Kind::PrefixUnaryExpression
                if parent.as_prefix_unary_expression().operator() == Kind::ExclamationToken => {}
            Kind::BinaryExpression
                if matches!(
                    parent.as_binary_expression().operator_token().kind(),
                    Kind::AmpersandAmpersandToken | Kind::BarBarToken
                ) => {}
            Kind::IfStatement => return parent.as_if_statement().expression() == current,
            Kind::ConditionalExpression => {
                return parent.as_conditional_expression().condition() == current;
            }
            _ => return false,
        }
        current = parent;
    }
    false
}

fn collect_symbol_references(
    checker: &mut Checker,
    node: P<Node>,
    target: P<Symbol>,
    out: &mut Vec<P<Node>>,
) {
    if ast::is_identifier(node) && checker.get_symbol_at_location_exported(node) == Some(target) {
        out.push(node);
    }
    node.for_each_child(&mut |child| {
        collect_symbol_references(checker, child, target, out);
        false
    });
}

fn is_mode_flag_only(checker: &mut Checker, body: P<Node>, param_symbol: P<Symbol>) -> bool {
    let mut references = Vec::new();
    collect_symbol_references(checker, body, param_symbol, &mut references);
    !references.is_empty()
        && references
            .iter()
            .all(|&reference| is_condition_position(reference))
}

fn is_setter_name(name: &str) -> bool {
    name.strip_prefix("set")
        .is_some_and(|rest| rest.starts_with(|first: char| first.is_ascii_uppercase()))
}

fn check_boolean_flag_parameters(ctx: &mut Ctx, fn_node: P<Node>) {
    let (Some(body), Some(name_node)) = (fn_node.body(), fn_node.name()) else {
        return;
    };
    if !ast::is_identifier(name_node) {
        return;
    }
    let fn_name = name_node.as_identifier().text();
    if is_setter_name(fn_name) {
        return;
    }
    let Some(fn_symbol) = provenance::symbol_at_node(ctx.checker, name_node) else {
        return;
    };
    let index = ProgramSymbolIndex::for_program(ctx.program);
    for (param_index, &param) in fn_node.parameters().iter().enumerate() {
        let Some(name) = parameter_identifier(param, Kind::BooleanKeyword) else {
            continue;
        };
        let is_plain_flag = param
            .as_parameter_declaration()
            .initializer()
            .is_none_or(|init| matches!(init.kind(), Kind::TrueKeyword | Kind::FalseKeyword));
        let Some(param_symbol) = ctx.checker.get_symbol_at_location_exported(name) else {
            continue;
        };
        if !is_plain_flag || !is_mode_flag_only(ctx.checker, body, param_symbol) {
            continue;
        }
        let literal_call = index
            .call_sites_for_symbol(ctx.checker, fn_symbol, fn_name)
            .iter()
            .any(|site| {
                site.arg_nodes
                    .get(param_index)
                    .is_some_and(|arg| matches!(arg.kind(), Kind::TrueKeyword | Kind::FalseKeyword))
            });
        if literal_call {
            let text = name.as_identifier().text();
            ctx.report_node(
                param,
                RuleMessage::new(
                    "booleanFlagModeParameter",
                    format!(
                        "'{fn_name}' takes a positional boolean '{text}' that only selects a branch, and callers pass bare 'true'/'false'. Split '{fn_name}' into one function per mode or take a named mode union."
                    ),
                ),
            );
        }
    }
}
