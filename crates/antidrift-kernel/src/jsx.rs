use crate::local_binding::{
    Binding, binding_for_declarator, collect_binding_references, is_write_reference,
};
use crate::tsrs_kernel::{is_function_like, node_range, unwrap_parentheses};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

const CLASS_HELPERS: [&str; 4] = ["clsx", "cn", "cva", "twMerge"];

#[derive(Clone, Copy)]
pub struct StringFragment {
    pub node: P<Node>,
    pub text: &'static str,
}

#[must_use]
pub fn string_fragments(sf: P<SourceFile>) -> Vec<StringFragment> {
    let mut out = Vec::new();
    collect_fragments(sf, sf.as_node(), &mut out);
    out
}

fn collect_fragments(sf: P<SourceFile>, node: P<Node>, out: &mut Vec<StringFragment>) {
    let src = sf.text();
    match node.kind() {
        Kind::StringLiteral => {
            out.push(StringFragment {
                node,
                text: node.as_string_literal().text(),
            });
        }
        Kind::NoSubstitutionTemplateLiteral | Kind::TemplateTail => {
            let (start, end) = node_range(sf, node);
            if end >= start + 2 {
                out.push(StringFragment {
                    node,
                    text: &src[start + 1..end - 1],
                });
            }
        }
        Kind::TemplateHead | Kind::TemplateMiddle => {
            let (start, end) = node_range(sf, node);
            if end >= start + 3 {
                out.push(StringFragment {
                    node,
                    text: &src[start + 1..end - 2],
                });
            }
        }
        _ => {}
    }
    node.for_each_child(&mut |child| {
        collect_fragments(sf, child, out);
        false
    });
}

#[must_use]
pub fn class_fragments(sf: P<SourceFile>) -> Vec<StringFragment> {
    string_fragments(sf)
        .into_iter()
        .filter(|fragment| is_class_value(sf, fragment.node, &FxHashSet::default()))
        .collect()
}

fn is_class_property_key(key: P<Node>) -> bool {
    match key.kind() {
        Kind::Identifier => key.as_identifier().text() == "className",
        Kind::StringLiteral => key.as_string_literal().text() == "className",
        _ => false,
    }
}

fn is_class_helper_call(callee: P<Node>) -> bool {
    ast::is_identifier(callee) && CLASS_HELPERS.contains(&callee.as_identifier().text())
}

fn binding_feeds_class_value(
    sf: P<SourceFile>,
    binding: Binding,
    seen: &FxHashSet<Binding>,
) -> bool {
    if seen.contains(&binding) {
        return false;
    }
    let mut branch_seen = seen.clone();
    branch_seen.insert(binding);
    collect_binding_references(sf.as_node(), binding)
        .into_iter()
        .any(|reference| {
            !is_write_reference(reference) && is_class_value(sf, reference, &branch_seen)
        })
}

#[must_use]
pub fn is_class_value(sf: P<SourceFile>, node: P<Node>, seen: &FxHashSet<Binding>) -> bool {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        match ancestor.kind() {
            Kind::VariableDeclaration => {
                return binding_for_declarator(ancestor)
                    .is_some_and(|binding| binding_feeds_class_value(sf, binding, seen));
            }
            Kind::JsxAttribute => {
                return plain_attribute_name(ancestor) == Some("className");
            }
            Kind::PropertyAssignment => {
                return is_class_property_key(ancestor.as_property_assignment().name());
            }
            Kind::ShorthandPropertyAssignment => {
                return is_class_property_key(ancestor.as_shorthand_property_assignment().name());
            }
            Kind::CallExpression => {
                return is_class_helper_call(ancestor.as_call_expression().expression());
            }
            Kind::TemplateExpression
            | Kind::TemplateSpan
            | Kind::NoSubstitutionTemplateLiteral
            | Kind::JsxExpression
            | Kind::ConditionalExpression
            | Kind::BinaryExpression
            | Kind::ArrayLiteralExpression
            | Kind::ParenthesizedExpression => {}
            _ => return false,
        }
        cursor = ancestor.parent();
    }
    false
}

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
