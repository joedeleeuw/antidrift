use antidrift_kernel::tsrs_kernel;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, SignatureKind, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor, options_object};

pub struct ReactMaxComponentProps {
    max: usize,
}

pub static RULE: ReactMaxComponentProps = ReactMaxComponentProps { max: 12 };

impl ReactMaxComponentProps {
    #[must_use]
    pub fn from_options(options: Option<&serde_json::Value>) -> Self {
        let max = options_object(options)
            .get("max")
            .and_then(serde_json::Value::as_u64)
            .map_or(12, |val| val as usize);
        Self { max: max.max(1) }
    }
}

fn build_max_component_props_message(count: usize, max: usize) -> RuleMessage {
    RuleMessage::new(
        "maxComponentProps",
        format!(
            "React component accepts too many locally-owned props ({count} > {max}). Split cohesive props into an owned object, resource, or smaller component boundary."
        ),
    )
}

fn callee_terminal_name(callee: P<Node>) -> Option<&'static str> {
    let unwrapped = tsrs_kernel::unwrap_expression(callee);
    match unwrapped.kind() {
        Kind::Identifier => Some(unwrapped.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let name = unwrapped.as_property_access_expression().name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    }
}

fn unwrap_react_callable(expr: P<Node>) -> Option<P<Node>> {
    let mut current = tsrs_kernel::unwrap_expression(expr);
    for _ in 0..4 {
        if current.kind() != Kind::CallExpression {
            break;
        }
        let call = current.as_call_expression();
        let Some(name) = callee_terminal_name(call.expression()) else {
            break;
        };
        if !matches!(name, "forwardRef" | "memo") {
            break;
        }
        let Some(&first_arg) = call.arguments().nodes().first() else {
            break;
        };
        current = tsrs_kernel::unwrap_expression(first_arg);
    }
    matches!(
        current.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    )
    .then_some(current)
}

fn get_function_node(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::FunctionDeclaration | Kind::MethodDeclaration => Some(node),
        Kind::VariableDeclaration => node
            .as_variable_declaration()
            .initializer()
            .and_then(unwrap_react_callable),
        Kind::PropertyDeclaration => node
            .as_property_declaration()
            .initializer()
            .and_then(unwrap_react_callable),
        Kind::PropertyAssignment => {
            unwrap_react_callable(node.as_property_assignment().initializer())
        }
        _ => None,
    }
}

fn contains_jsx(node: Option<P<Node>>) -> bool {
    let Some(current) = node else {
        return false;
    };
    if matches!(
        current.kind(),
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment
    ) {
        return true;
    }
    if tsrs_kernel::is_function_like(current) {
        return false;
    }
    current.for_each_child(&mut |child| contains_jsx(Some(child)))
}

fn record_jsx_variable_decl(decl: P<Node>, locals: &mut FxHashSet<String>) {
    let var_decl = decl.as_variable_declaration();
    let name = var_decl.name();
    if name.kind() == Kind::Identifier && contains_jsx(var_decl.initializer()) {
        locals.insert(name.as_identifier().text().to_owned());
    }
}

fn collect_jsx_locals(statements: &[P<Node>]) -> FxHashSet<String> {
    let mut locals = FxHashSet::default();
    for &stmt in statements {
        if stmt.kind() != Kind::VariableStatement {
            continue;
        }
        let decls = stmt
            .as_variable_statement()
            .declaration_list()
            .as_variable_declaration_list()
            .declarations()
            .nodes();
        for &decl in decls {
            record_jsx_variable_decl(decl, &mut locals);
        }
    }
    locals
}

fn switch_returns_jsx(stmt: P<Node>, jsx_locals: &FxHashSet<String>) -> bool {
    let clauses = stmt
        .as_switch_statement()
        .case_block()
        .as_case_block()
        .clauses()
        .nodes();
    clauses.iter().copied().any(|clause| {
        clause
            .as_case_or_default_clause()
            .statements()
            .nodes()
            .iter()
            .copied()
            .any(|child| statement_returns_jsx(child, jsx_locals))
    })
}

fn try_returns_jsx(stmt: P<Node>, jsx_locals: &FxHashSet<String>) -> bool {
    let try_stmt = stmt.as_try_statement();
    statement_returns_jsx(try_stmt.try_block(), jsx_locals)
        || try_stmt.catch_clause().is_some_and(|catch_node| {
            statement_returns_jsx(catch_node.as_catch_clause().block(), jsx_locals)
        })
        || try_stmt
            .finally_block()
            .is_some_and(|finally_node| statement_returns_jsx(finally_node, jsx_locals))
}

fn statement_returns_jsx(stmt: P<Node>, jsx_locals: &FxHashSet<String>) -> bool {
    match stmt.kind() {
        Kind::ReturnStatement => {
            let Some(expr) = stmt.as_return_statement().expression() else {
                return false;
            };
            if contains_jsx(Some(expr)) {
                return true;
            }
            let unwrapped = tsrs_kernel::unwrap_expression(expr);
            unwrapped.kind() == Kind::Identifier
                && jsx_locals.contains(unwrapped.as_identifier().text())
        }
        Kind::Block => stmt
            .as_block()
            .statements()
            .nodes()
            .iter()
            .copied()
            .any(|child| statement_returns_jsx(child, jsx_locals)),
        Kind::IfStatement => {
            let if_stmt = stmt.as_if_statement();
            statement_returns_jsx(if_stmt.then_statement(), jsx_locals)
                || if_stmt
                    .else_statement()
                    .is_some_and(|else_stmt| statement_returns_jsx(else_stmt, jsx_locals))
        }
        Kind::SwitchStatement => switch_returns_jsx(stmt, jsx_locals),
        Kind::TryStatement => try_returns_jsx(stmt, jsx_locals),
        Kind::LabeledStatement => {
            statement_returns_jsx(stmt.as_labeled_statement().statement(), jsx_locals)
        }
        Kind::WhileStatement => {
            statement_returns_jsx(stmt.as_while_statement().statement(), jsx_locals)
        }
        Kind::DoStatement => statement_returns_jsx(stmt.as_do_statement().statement(), jsx_locals),
        Kind::ForStatement => {
            statement_returns_jsx(stmt.as_for_statement().statement(), jsx_locals)
        }
        Kind::ForInStatement | Kind::ForOfStatement => {
            statement_returns_jsx(stmt.as_for_in_or_of_statement().statement(), jsx_locals)
        }
        _ => false,
    }
}

fn function_returns_jsx(fn_node: P<Node>) -> bool {
    let Some(body) = fn_node.body() else {
        return false;
    };
    if body.kind() != Kind::Block {
        return contains_jsx(Some(body));
    }
    let statements = body.as_block().statements().nodes();
    let jsx_locals = collect_jsx_locals(statements);
    statements
        .iter()
        .copied()
        .any(|stmt| statement_returns_jsx(stmt, &jsx_locals))
}

fn is_external_declaration(decl: P<Node>) -> bool {
    let Some(sf) = ast::get_source_file_of_node(decl) else {
        return true;
    };
    tsrs_kernel::normalize_path(sf.file_name()).contains("/node_modules/")
}

fn is_locally_declared_property(symbol: P<Symbol>) -> bool {
    let declarations = symbol.declarations();
    !declarations.is_empty()
        && declarations
            .iter()
            .copied()
            .any(|decl| !is_external_declaration(decl))
}

fn local_prop_names_for_type(checker: &mut Checker, typ: P<Type>) -> FxHashSet<String> {
    if typ.flags().intersects(TypeFlags::Union) {
        let mut best = FxHashSet::default();
        for &part in typ.types() {
            let names = local_prop_names_for_type(checker, part);
            if names.len() > best.len() {
                best = names;
            }
        }
        return best;
    }
    let apparent = checker.get_apparent_type_exported(typ);
    let mut names = FxHashSet::default();
    for &prop in checker.get_properties_of_type(apparent) {
        let name = prop.name();
        if !name.is_empty() && !name.starts_with("__") && is_locally_declared_property(prop) {
            names.insert(name.to_owned());
        }
    }
    names
}

fn fc_props_type_node(type_node: P<Node>) -> Option<P<Node>> {
    if type_node.kind() != Kind::TypeReference {
        return None;
    }
    let type_ref = type_node.as_type_reference_node();
    let type_name = type_ref.type_name();
    let is_fc = match type_name.kind() {
        Kind::Identifier => matches!(type_name.as_identifier().text(), "FC" | "FunctionComponent"),
        Kind::QualifiedName => {
            let qn = type_name.as_qualified_name();
            qn.left().kind() == Kind::Identifier
                && qn.left().as_identifier().text() == "React"
                && matches!(
                    qn.right().as_identifier().text(),
                    "FC" | "FunctionComponent"
                )
        }
        _ => false,
    };
    if !is_fc {
        return None;
    }
    type_ref
        .type_arguments()
        .and_then(|args| args.nodes().first().copied())
}

fn fc_annotated_prop_count(checker: &mut Checker, type_node: Option<P<Node>>) -> usize {
    let Some(props_node) = type_node.and_then(fc_props_type_node) else {
        return 0;
    };
    if !ast::is_type_node(props_node) {
        return 0;
    }
    let props_type = checker.get_type_from_type_node_exported(props_node);
    local_prop_names_for_type(checker, props_type).len()
}

fn typed_prop_count_for_callable_node(checker: &mut Checker, node: P<Node>) -> usize {
    if node.kind() != Kind::VariableDeclaration {
        return 0;
    }
    let var_decl = node.as_variable_declaration();
    let var_name = var_decl.name();
    if var_name.kind() != Kind::Identifier {
        return 0;
    }
    let fc_count = fc_annotated_prop_count(checker, var_decl.type_());
    if fc_count > 0 {
        return fc_count;
    }
    let callable_type = checker.get_type_at_location(var_name);
    let Some(&first_sig) = checker
        .get_signatures_of_type(callable_type, SignatureKind::Call)
        .first()
    else {
        return 0;
    };
    let Some(&first_param) = first_sig.parameters().first() else {
        return 0;
    };
    let Some(param_type) = checker.get_type_of_symbol_at_location(first_param, Some(var_name))
    else {
        return 0;
    };
    local_prop_names_for_type(checker, param_type).len()
}

fn object_pattern_prop_count(param_name: P<Node>) -> usize {
    if param_name.kind() != Kind::ObjectBindingPattern {
        return 0;
    }
    param_name
        .as_binding_pattern()
        .elements()
        .nodes()
        .iter()
        .copied()
        .filter(|elem| {
            elem.kind() == Kind::BindingElement
                && elem.as_binding_element().dot_dot_dot_token().is_none()
        })
        .count()
}

fn collect_spread_names(param_name: P<Node>) -> FxHashSet<String> {
    let mut names = FxHashSet::default();
    if param_name.kind() == Kind::Identifier {
        names.insert(param_name.as_identifier().text().to_owned());
        return names;
    }
    if param_name.kind() != Kind::ObjectBindingPattern {
        return names;
    }
    for &elem in param_name.as_binding_pattern().elements().nodes() {
        if elem.kind() == Kind::BindingElement {
            let binding = elem.as_binding_element();
            if binding.dot_dot_dot_token().is_some()
                && let Some(name_node) = binding.name()
                && name_node.kind() == Kind::Identifier
            {
                names.insert(name_node.as_identifier().text().to_owned());
            }
        }
    }
    names
}

fn is_matching_spread_attr(node: P<Node>, spread_names: &FxHashSet<String>) -> bool {
    if node.kind() != Kind::JsxSpreadAttribute {
        return false;
    }
    let expr = tsrs_kernel::unwrap_expression(node.as_jsx_spread_attribute().expression());
    expr.kind() == Kind::Identifier && spread_names.contains(expr.as_identifier().text())
}

fn contains_jsx_spread_of(node: Option<P<Node>>, spread_names: &FxHashSet<String>) -> bool {
    let Some(current) = node else {
        return false;
    };
    if is_matching_spread_attr(current, spread_names) {
        return true;
    }
    if tsrs_kernel::is_function_like(current) {
        return false;
    }
    current.for_each_child(&mut |child| contains_jsx_spread_of(Some(child), spread_names))
}

fn forwards_props_as_spread(fn_node: P<Node>, param_name: P<Node>, max: usize) -> bool {
    let spread_names = collect_spread_names(param_name);
    if spread_names.is_empty() || !contains_jsx_spread_of(fn_node.body(), &spread_names) {
        return false;
    }
    param_name.kind() != Kind::ObjectBindingPattern || object_pattern_prop_count(param_name) <= max
}

fn check_component_node(ctx: &mut Ctx, node: P<Node>, max: usize) {
    let Some(fn_node) = get_function_node(node) else {
        return;
    };
    if !function_returns_jsx(fn_node) {
        return;
    }
    let Some(&first_param) = fn_node.parameters().first() else {
        return;
    };
    let param_name = first_param.as_parameter_declaration().name();
    if forwards_props_as_spread(fn_node, param_name, max) {
        return;
    }
    let param_type = ctx.checker.get_type_at_location(first_param);
    let param_typed_count = local_prop_names_for_type(ctx.checker, param_type).len();
    let callable_typed_count = typed_prop_count_for_callable_node(ctx.checker, node);
    let typed_count = param_typed_count.max(callable_typed_count);
    let count = object_pattern_prop_count(param_name).max(typed_count);
    if count > max {
        ctx.report_node(first_param, build_max_component_props_message(count, max));
    }
}

impl Rule for ReactMaxComponentProps {
    fn name(&self) -> &'static str {
        "antidrift/react-max-component-props"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor { max: self.max })
    }
}

struct Visitor {
    max: usize,
}

const LISTENERS: [Listener; 5] = [
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertyAssignment),
];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_component_node(ctx, node, self.max);
    }
}
