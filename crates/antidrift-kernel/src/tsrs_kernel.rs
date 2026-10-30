pub use tsrs_ast::skip_parentheses as unwrap_parentheses;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
pub use tsrs_core::tspath::normalize_slashes as normalize_path;
use tsrslint::utils::trim_node_text_range;

#[must_use]
pub fn assertion_parts(node: P<Node>) -> Option<(P<Node>, P<Node>)> {
    match node.kind() {
        Kind::AsExpression => {
            let as_expr = node.as_as_expression();
            Some((as_expr.expression(), as_expr.type_()))
        }
        Kind::TypeAssertionExpression => {
            let assertion = node.as_type_assertion();
            Some((assertion.expression(), assertion.type_()))
        }
        _ => None,
    }
}

#[must_use]
pub fn is_const_assertion(type_node: P<Node>) -> bool {
    if type_node.kind() != Kind::TypeReference {
        return false;
    }
    let name = type_node.as_type_reference_node().type_name();
    ast::is_identifier(name) && name.as_identifier().text() == "const"
}

#[must_use]
pub fn unwrap_expression(node: P<Node>) -> P<Node> {
    ast::skip_outer_expressions(node, ast::OEK::Parentheses | ast::OEK::Assertions)
}

#[must_use]
pub fn unwrap_awaited_expression(node: P<Node>) -> P<Node> {
    let mut current = unwrap_expression(node);
    while ast::is_await_expression(current) {
        current = unwrap_expression(current.as_await_expression().expression());
    }
    current
}

#[must_use]
pub fn is_function_like(node: P<Node>) -> bool {
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

#[must_use]
pub fn is_generator_function(node: P<Node>) -> bool {
    node.body_data()
        .and_then(ast::BodyBase::asterisk_token)
        .is_some()
}

#[must_use]
pub fn enclosing_function(node: P<Node>) -> Option<P<Node>> {
    let mut current = node.parent();
    while let Some(curr) = current {
        if is_function_like(curr) {
            return Some(curr);
        }
        current = curr.parent();
    }
    None
}

#[must_use]
pub fn function_node_from_declaration(node: P<Node>) -> Option<P<Node>> {
    if is_function_like(node) {
        return Some(node);
    }
    let init = match node.kind() {
        Kind::VariableDeclaration => node.as_variable_declaration().initializer(),
        Kind::PropertyDeclaration => node.as_property_declaration().initializer(),
        Kind::PropertyAssignment => Some(node.as_property_assignment().initializer()),
        _ => None,
    }?;
    let unwrapped = unwrap_expression(init);
    is_function_like(unwrapped).then_some(unwrapped)
}

#[must_use]
pub fn property_name_text(name: P<Node>) -> Option<&'static str> {
    match name.kind() {
        Kind::Identifier => Some(name.as_identifier().text()),
        Kind::PrivateIdentifier => {
            Some(name.as_private_identifier().text().trim_start_matches('#'))
        }
        Kind::StringLiteral | Kind::NumericLiteral | Kind::NoSubstitutionTemplateLiteral => {
            cooked_text(name)
        }
        Kind::ComputedPropertyName => {
            let expr = unwrap_expression(name.as_computed_property_name().expression());
            if ast::is_string_literal(expr)
                || ast::is_numeric_literal(expr)
                || ast::is_no_substitution_template_literal(expr)
            {
                cooked_text(expr)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[must_use]
pub fn function_name(node: P<Node>) -> Option<&'static str> {
    if let Some(name_node) = node.name()
        && let Some(text) = property_name_text(name_node)
    {
        return Some(text);
    }
    if let Some(parent) = node.parent()
        && matches!(
            parent.kind(),
            Kind::VariableDeclaration | Kind::PropertyDeclaration | Kind::PropertyAssignment
        )
        && let Some(name_node) = parent.name()
        && let Some(text) = property_name_text(name_node)
    {
        return Some(text);
    }
    None
}

#[must_use]
pub fn function_return_type_node(func: P<Node>) -> Option<P<Node>> {
    func.function_like_data()
        .and_then(ast::FunctionLikeBase::type_)
}

#[must_use]
pub fn function_body_node(func: P<Node>) -> Option<P<Node>> {
    func.body()
}

#[must_use]
pub fn static_member_chain(node: P<Node>) -> Option<(P<Node>, Vec<&'static str>)> {
    let mut current = unwrap_expression(node);
    let mut members: Vec<&'static str> = Vec::new();
    loop {
        match current.kind() {
            Kind::PropertyAccessExpression => {
                let prop = current.as_property_access_expression();
                let name = property_name_text(prop.name())?;
                members.push(name);
                current = unwrap_expression(prop.expression());
            }
            Kind::ElementAccessExpression => {
                let elem = current.as_element_access_expression();
                let arg = unwrap_expression(elem.argument_expression());
                if !ast::is_string_literal(arg)
                    && !ast::is_numeric_literal(arg)
                    && !ast::is_no_substitution_template_literal(arg)
                {
                    return None;
                }
                members.push(cooked_text(arg)?);
                current = unwrap_expression(elem.expression());
            }
            _ => {
                if members.is_empty() {
                    return None;
                }
                members.reverse();
                return Some((current, members));
            }
        }
    }
}

#[must_use]
pub fn member_object(node: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(node);
    match inner.kind() {
        Kind::PropertyAccessExpression => Some(inner.as_property_access_expression().expression()),
        Kind::ElementAccessExpression => Some(inner.as_element_access_expression().expression()),
        _ => None,
    }
}

#[must_use]
pub fn member_chain_root_node(node: P<Node>) -> Option<P<Node>> {
    let mut current = unwrap_expression(node);
    while let Some(obj) = member_object(current) {
        current = unwrap_expression(obj);
    }
    ast::is_identifier(current).then_some(current)
}

#[must_use]
pub fn member_chain_root_identifier(node: P<Node>) -> Option<&'static str> {
    let (root, _) = static_member_chain(node)?;
    ast::is_identifier(root).then(|| root.as_identifier().text())
}

#[must_use]
pub fn callee_name(call: P<Node>) -> Option<&'static str> {
    let callee = unwrap_expression(call.as_call_expression().expression());
    if ast::is_identifier(callee) {
        return Some(callee.as_identifier().text());
    }
    terminal_member_name(callee)
}

#[must_use]
pub fn terminal_member_name(node: P<Node>) -> Option<&'static str> {
    let unwrapped = unwrap_expression(node);
    match unwrapped.kind() {
        Kind::PropertyAccessExpression => {
            property_name_text(unwrapped.as_property_access_expression().name())
        }
        Kind::ElementAccessExpression => {
            let arg = unwrap_expression(
                unwrapped
                    .as_element_access_expression()
                    .argument_expression(),
            );
            (ast::is_string_literal(arg) || ast::is_no_substitution_template_literal(arg))
                .then_some(arg)
                .and_then(cooked_text)
        }
        _ => None,
    }
}

#[must_use]
pub fn is_undefined_or_void_expression(node: Option<P<Node>>) -> bool {
    node.is_none_or(|expr| {
        let unwrapped = unwrap_expression(expr);
        (ast::is_identifier(unwrapped) && unwrapped.as_identifier().text() == "undefined")
            || ast::is_void_expression(unwrapped)
    })
}

#[must_use]
pub fn expression_literal_key(node: P<Node>) -> Option<String> {
    let unwrapped = unwrap_expression(node);
    match unwrapped.kind() {
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => {
            cooked_text(unwrapped).map(|text| format!("string:{text}"))
        }
        Kind::NumericLiteral => Some(format!("number:{}", unwrapped.as_numeric_literal().text())),
        Kind::TrueKeyword => Some("boolean:true".to_owned()),
        Kind::FalseKeyword => Some("boolean:false".to_owned()),
        Kind::NullKeyword => Some("object:null".to_owned()),
        _ => None,
    }
}

fn collect_returns(node: P<Node>, body: P<Node>, results: &mut Vec<P<Node>>) {
    if node != body && is_function_like(node) {
        return;
    }
    if ast::is_return_statement(node) {
        if let Some(expr) = node.as_return_statement().expression() {
            results.push(expr);
        }
        return;
    }
    node.for_each_child(&mut |child| {
        collect_returns(child, body, results);
        false
    });
}

#[must_use]
pub fn collect_return_expressions(body: Option<P<Node>>) -> Vec<P<Node>> {
    let Some(body_node) = body else {
        return Vec::new();
    };
    if !ast::is_block(body_node) {
        return vec![body_node];
    }
    let mut results = Vec::new();
    collect_returns(body_node, body_node, &mut results);
    results
}

fn visit_call_or_new(node: P<Node>, root: P<Node>) -> bool {
    if node != root && is_function_like(node) {
        return false;
    }
    if ast::is_call_expression(node)
        || ast::is_new_expression(node)
        || ast::is_tagged_template_expression(node)
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if visit_call_or_new(child, root) {
            found = true;
            return true;
        }
        false
    });
    found
}

#[must_use]
pub fn contains_call_or_new(root: Option<P<Node>>) -> bool {
    let Some(root_node) = root else {
        return false;
    };
    visit_call_or_new(root_node, root_node)
}

#[must_use]
pub fn node_range(sf: P<SourceFile>, node: P<Node>) -> (usize, usize) {
    let (pos, end) = trim_node_text_range(sf, node);
    let start_idx = usize::try_from(pos).unwrap_or(0);
    let end_idx = usize::try_from(end).unwrap_or(start_idx);
    (start_idx, end_idx)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: i32,
    pub end: i32,
}

impl Span {
    #[must_use]
    pub fn of(sf: P<SourceFile>, node: P<Node>) -> Self {
        let (start, end) = trim_node_text_range(sf, node);
        Self { start, end }
    }

    #[must_use]
    pub const fn contains_inclusive(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }
}

#[must_use]
pub fn identifier_of(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    ast::is_identifier(inner).then_some(inner)
}

#[must_use]
pub fn call_expression_of(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    (inner.kind() == Kind::CallExpression).then_some(inner)
}

#[must_use]
pub fn numeric_literal_value(expression: P<Node>) -> Option<f64> {
    if expression.kind() != Kind::NumericLiteral {
        return None;
    }
    let clean = expression.as_numeric_literal().text().replace('_', "");
    for (lower, upper, radix) in [("0x", "0X", 16), ("0o", "0O", 8), ("0b", "0B", 2)] {
        if let Some(rest) = clean
            .strip_prefix(lower)
            .or_else(|| clean.strip_prefix(upper))
        {
            let Ok(val) = u64::from_str_radix(rest, radix) else {
                return None;
            };
            return Some(val as f64);
        }
    }
    let Ok(value) = clean.parse::<f64>() else {
        return None;
    };
    Some(value)
}

#[must_use]
#[expect(
    clippy::disallowed_methods,
    reason = "cooked_text is the one reader of tsrs cooked text; it validates the WTF-8 bytes tsrs stores for lone-surrogate escapes before any caller decodes chars"
)]
pub fn cooked_text(node: P<Node>) -> Option<&'static str> {
    let cooked = node.text();
    std::str::from_utf8(cooked.as_bytes())
        .is_ok()
        .then_some(cooked)
}

#[must_use]
pub fn node_text(sf: P<SourceFile>, node: P<Node>) -> &'static str {
    let (start_idx, end_idx) = node_range(sf, node);
    sf.text().get(start_idx..end_idx).unwrap_or("")
}

#[must_use]
pub fn union_or_intersection_type_nodes(type_node: P<Node>) -> &'static [P<Node>] {
    match type_node.kind() {
        Kind::UnionType => type_node.as_union_type_node().types().nodes(),
        Kind::IntersectionType => type_node.as_intersection_type_node().types().nodes(),
        _ => &[],
    }
}
