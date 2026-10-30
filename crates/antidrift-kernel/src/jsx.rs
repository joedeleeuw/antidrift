use crate::tsrs_kernel::{
    function_name, is_function_like, property_name_text, unwrap_expression, unwrap_parentheses,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

#[must_use]
pub fn is_jsx_element_like(node: P<Node>) -> bool {
    matches!(node.kind(), Kind::JsxElement | Kind::JsxSelfClosingElement)
}

#[must_use]
pub fn jsx_opening_node(node: P<Node>) -> P<Node> {
    if node.kind() == Kind::JsxElement {
        node.as_jsx_element().opening_element()
    } else {
        node
    }
}

#[must_use]
pub fn jsx_children(node: P<Node>) -> &'static [P<Node>] {
    if node.kind() == Kind::JsxElement {
        node.as_jsx_element().children().nodes()
    } else {
        &[]
    }
}

#[must_use]
pub fn opening_tag_name_node(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::JsxOpeningElement => Some(node.as_jsx_opening_element().tag_name()),
        Kind::JsxSelfClosingElement => Some(node.as_jsx_self_closing_element().tag_name()),
        Kind::JsxElement => Some(
            node.as_jsx_element()
                .opening_element()
                .as_jsx_opening_element()
                .tag_name(),
        ),
        _ => None,
    }
}

#[must_use]
pub fn element_tag_name(node: P<Node>) -> Option<&'static str> {
    let tag = opening_tag_name_node(node).unwrap_or(node);
    match tag.kind() {
        Kind::Identifier => Some(tag.as_identifier().text()),
        Kind::ThisKeyword => Some("this"),
        Kind::PropertyAccessExpression => {
            let prop = tag.as_property_access_expression().name();
            ast::is_identifier(prop).then(|| prop.as_identifier().text())
        }
        Kind::JsxNamespacedName => {
            let name = tag.as_jsx_namespaced_name().name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    }
}

#[must_use]
pub fn plain_element_name(node: P<Node>) -> Option<&'static str> {
    let tag = opening_tag_name_node(node).unwrap_or(node);
    match tag.kind() {
        Kind::Identifier => Some(tag.as_identifier().text()),
        Kind::ThisKeyword => Some("this"),
        _ => None,
    }
}

#[must_use]
pub fn jsx_attributes_list(node: P<Node>) -> &'static [P<Node>] {
    match node.kind() {
        Kind::JsxOpeningElement => node
            .as_jsx_opening_element()
            .attributes()
            .as_jsx_attributes()
            .properties()
            .nodes(),
        Kind::JsxSelfClosingElement => node
            .as_jsx_self_closing_element()
            .attributes()
            .as_jsx_attributes()
            .properties()
            .nodes(),
        Kind::JsxElement => jsx_attributes_list(node.as_jsx_element().opening_element()),
        Kind::JsxAttributes => node.as_jsx_attributes().properties().nodes(),
        _ => &[],
    }
}

#[must_use]
pub fn attribute_name(attribute: P<Node>) -> Option<&'static str> {
    if attribute.kind() != Kind::JsxAttribute {
        return None;
    }
    let name = attribute.as_jsx_attribute().name();
    match name.kind() {
        Kind::Identifier => Some(name.as_identifier().text()),
        Kind::JsxNamespacedName => {
            let local = name.as_jsx_namespaced_name().name();
            ast::is_identifier(local).then(|| local.as_identifier().text())
        }
        _ => None,
    }
}

#[must_use]
pub fn plain_attribute_name(attribute: P<Node>) -> Option<&'static str> {
    if attribute.kind() != Kind::JsxAttribute {
        return None;
    }
    let name = attribute.as_jsx_attribute().name();
    ast::is_identifier(name).then(|| name.as_identifier().text())
}

#[must_use]
pub fn find_attribute(node: P<Node>, target: &str) -> Option<P<Node>> {
    jsx_attributes_list(node)
        .iter()
        .copied()
        .find(|&attr| attribute_name(attr) == Some(target))
}

#[must_use]
pub fn has_plain_attribute(node: P<Node>, target: &str) -> bool {
    jsx_attributes_list(node)
        .iter()
        .copied()
        .any(|attr| plain_attribute_name(attr) == Some(target))
}

#[must_use]
pub fn has_spread_attribute(node: P<Node>) -> bool {
    jsx_attributes_list(node)
        .iter()
        .any(|attr| attr.kind() == Kind::JsxSpreadAttribute)
}

#[must_use]
pub fn attribute_initializer_expression(attribute: P<Node>) -> Option<P<Node>> {
    if attribute.kind() != Kind::JsxAttribute {
        return None;
    }
    let init = attribute.as_jsx_attribute().initializer()?;
    if init.kind() == Kind::JsxExpression {
        init.as_jsx_expression().expression()
    } else {
        None
    }
}

#[must_use]
pub fn static_attribute_string(attribute: P<Node>) -> Option<&'static str> {
    if attribute.kind() != Kind::JsxAttribute {
        return None;
    }
    let init = attribute.as_jsx_attribute().initializer()?;
    match init.kind() {
        Kind::StringLiteral => Some(init.as_string_literal().text()),
        Kind::JsxExpression => {
            let expr = unwrap_parentheses(init.as_jsx_expression().expression()?);
            if expr.kind() == Kind::StringLiteral {
                Some(expr.as_string_literal().text())
            } else {
                None
            }
        }
        _ => None,
    }
}

#[must_use]
pub fn render_prop_element(node: P<Node>) -> Option<P<Node>> {
    let attr = find_attribute(node, "render")?;
    let init = attr.as_jsx_attribute().initializer()?;
    match init.kind() {
        Kind::JsxElement | Kind::JsxSelfClosingElement => Some(init),
        Kind::JsxExpression => {
            let expr = unwrap_parentheses(init.as_jsx_expression().expression()?);
            matches!(expr.kind(), Kind::JsxElement | Kind::JsxSelfClosingElement).then_some(expr)
        }
        _ => None,
    }
}

#[must_use]
pub fn expression_contains_jsx(node: P<Node>) -> bool {
    if matches!(
        node.kind(),
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment
    ) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found || is_function_like(child) {
            return true;
        }
        if expression_contains_jsx(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

#[must_use]
pub fn function_returns_jsx(function_node: P<Node>) -> bool {
    let Some(body) = function_node.body() else {
        return false;
    };
    if body.kind() != Kind::Block {
        return expression_contains_jsx(body);
    }
    statements_return_jsx(body.as_block().statements().nodes(), &FxHashSet::default())
}

fn collect_jsx_locals(statement: P<Node>, locals: &mut FxHashSet<&'static str>) {
    if statement.kind() != Kind::VariableStatement {
        return;
    }
    let decl_list = statement.as_variable_statement().declaration_list();
    for &decl in decl_list
        .as_variable_declaration_list()
        .declarations()
        .nodes()
    {
        if decl.kind() != Kind::VariableDeclaration {
            continue;
        }
        let var_decl = decl.as_variable_declaration();
        let name = var_decl.name();
        if ast::is_identifier(name) && var_decl.initializer().is_some_and(expression_contains_jsx) {
            locals.insert(name.as_identifier().text());
        }
    }
}

fn statements_return_jsx(statements: &[P<Node>], outer_locals: &FxHashSet<&'static str>) -> bool {
    let mut locals = outer_locals.clone();
    for &statement in statements {
        collect_jsx_locals(statement, &mut locals);
        if statement_returns_jsx(statement, &locals) {
            return true;
        }
    }
    false
}

fn statement_returns_jsx(statement: P<Node>, locals: &FxHashSet<&'static str>) -> bool {
    match statement.kind() {
        Kind::ReturnStatement => statement
            .as_return_statement()
            .expression()
            .is_some_and(|expr| {
                expression_contains_jsx(expr) || {
                    let unwrapped = unwrap_parentheses(expr);
                    ast::is_identifier(unwrapped)
                        && locals.contains(unwrapped.as_identifier().text())
                }
            }),
        Kind::Block => statements_return_jsx(statement.as_block().statements().nodes(), locals),
        Kind::IfStatement => {
            let branch = statement.as_if_statement();
            statement_returns_jsx(branch.then_statement(), locals)
                || branch
                    .else_statement()
                    .is_some_and(|alt| statement_returns_jsx(alt, locals))
        }
        Kind::SwitchStatement => statement
            .as_switch_statement()
            .case_block()
            .as_case_block()
            .clauses()
            .nodes()
            .iter()
            .any(|&clause| {
                let stmts = match clause.kind() {
                    Kind::CaseClause | Kind::DefaultClause => {
                        clause.as_case_or_default_clause().statements().nodes()
                    }
                    _ => &[],
                };
                statements_return_jsx(stmts, locals)
            }),
        Kind::TryStatement => {
            let attempt = statement.as_try_statement();
            statements_return_jsx(attempt.try_block().as_block().statements().nodes(), locals)
                || attempt.catch_clause().is_some_and(|catch| {
                    statements_return_jsx(
                        catch
                            .as_catch_clause()
                            .block()
                            .as_block()
                            .statements()
                            .nodes(),
                        locals,
                    )
                })
                || attempt.finally_block().is_some_and(|fin| {
                    statements_return_jsx(fin.as_block().statements().nodes(), locals)
                })
        }
        Kind::LabeledStatement => {
            statement_returns_jsx(statement.as_labeled_statement().statement(), locals)
        }
        Kind::WhileStatement => {
            statement_returns_jsx(statement.as_while_statement().statement(), locals)
        }
        Kind::DoStatement => statement_returns_jsx(statement.as_do_statement().statement(), locals),
        Kind::ForStatement => {
            statement_returns_jsx(statement.as_for_statement().statement(), locals)
        }
        Kind::ForInStatement | Kind::ForOfStatement => {
            statement_returns_jsx(statement.as_for_in_or_of_statement().statement(), locals)
        }
        _ => false,
    }
}

#[must_use]
pub fn is_hook_name(name: &str) -> bool {
    name == "use"
        || name.strip_prefix("use").is_some_and(|rest| {
            rest.chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
        })
}

#[must_use]
pub fn is_pascal_case_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_uppercase())
}

#[must_use]
pub fn is_event_handler_name(name: &str) -> bool {
    name.strip_prefix("on")
        .or_else(|| name.strip_prefix("handle"))
        .and_then(|rest| rest.chars().next())
        .is_some_and(|ch| ch.is_ascii_uppercase())
}

fn is_react_hoc_call(call: P<Node>) -> bool {
    let callee = unwrap_expression(call.as_call_expression().expression());
    match callee.kind() {
        Kind::Identifier => matches!(callee.as_identifier().text(), "memo" | "forwardRef"),
        Kind::PropertyAccessExpression => {
            let access = callee.as_property_access_expression();
            ast::is_identifier(access.expression())
                && access.expression().as_identifier().text() == "React"
                && matches!(
                    property_name_text(access.name()),
                    Some("memo" | "forwardRef")
                )
        }
        _ => false,
    }
}

#[must_use]
pub fn react_function_name(node: P<Node>) -> Option<&'static str> {
    if let Some(name) = function_name(node) {
        return Some(name);
    }
    let parent = node.parent()?;
    if parent.kind() == Kind::CallExpression
        && is_react_hoc_call(parent)
        && let Some(grand) = parent.parent()
        && grand.kind() == Kind::VariableDeclaration
        && let Some(name_node) = grand.name()
        && let Some(text) = property_name_text(name_node)
    {
        return Some(text);
    }
    if parent.kind() == Kind::ExportAssignment {
        return Some("DefaultExportComponent");
    }
    None
}

#[must_use]
pub fn is_component_or_hook_function(node: P<Node>) -> bool {
    react_function_name(node).is_some_and(|name| is_pascal_case_name(name) || is_hook_name(name))
        || expression_contains_jsx(node)
}
