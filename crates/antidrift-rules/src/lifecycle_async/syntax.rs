pub(super) use antidrift_kernel::local_binding::{
    Binding, binding_for_declarator, collect_binding_references, const_binding_initializer,
    enclosing_variable_declaration, is_binding_mutated, is_const_variable_declaration,
    is_let_variable_declaration, is_var_variable_declaration, is_write_reference,
    resolve_lexical_binding,
};
pub(super) use antidrift_kernel::tsrs_kernel::{
    Span, call_expression_of, cooked_text, identifier_of, is_function_like, node_text,
    unwrap_expression, unwrap_parentheses,
};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

pub(super) fn member(expression: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name_node = access.name();
            match name_node.kind() {
                Kind::Identifier => Some((access.expression(), name_node.as_identifier().text())),
                Kind::PrivateIdentifier => Some((
                    access.expression(),
                    name_node.as_private_identifier().text(),
                )),
                _ => None,
            }
        }
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            let arg = unwrap_expression(access.argument_expression());
            if ast::is_string_literal(arg) {
                cooked_text(arg).map(|text| (access.expression(), text))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn identifier_member(expression: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = unwrap_parentheses(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name_node = access.name();
            ast::is_identifier(name_node)
                .then(|| (access.expression(), name_node.as_identifier().text()))
        }
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            let arg = unwrap_parentheses(access.argument_expression());
            ast::is_identifier(arg).then(|| (access.expression(), arg.as_identifier().text()))
        }
        _ => None,
    }
}

pub(super) fn property_name(key: P<Node>) -> Option<&'static str> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => cooked_text(key),
        Kind::ComputedPropertyName => {
            let expr = unwrap_parentheses(key.as_computed_property_name().expression());
            match expr.kind() {
                Kind::Identifier => Some(expr.as_identifier().text()),
                Kind::StringLiteral => cooked_text(expr),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(super) fn object_property(prop: P<Node>) -> Option<(P<Node>, P<Node>, bool)> {
    match prop.kind() {
        Kind::PropertyAssignment => {
            let assign = prop.as_property_assignment();
            let name = assign.name();
            Some((
                name,
                assign.initializer(),
                name.kind() == Kind::ComputedPropertyName,
            ))
        }
        Kind::ShorthandPropertyAssignment => {
            let short = prop.as_shorthand_property_assignment();
            let name = short.name();
            Some((name, name, false))
        }
        _ => None,
    }
}

pub(super) fn binding_property(elem: P<Node>) -> Option<(&'static str, P<Node>)> {
    let binding = (elem.kind() == Kind::BindingElement)
        .then(|| elem.as_binding_element())
        .filter(|b| b.dot_dot_dot_token().is_none())?;
    let value = binding.name()?;
    Some((
        property_name(binding.property_name().unwrap_or(value))?,
        value,
    ))
}

pub(super) fn property(expression: P<Node>, name: &str) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    (inner.kind() == Kind::ObjectLiteralExpression)
        .then(|| {
            inner
                .as_object_literal_expression()
                .properties()
                .nodes()
                .iter()
                .find_map(|&prop| {
                    let (key, value, _) = object_property(prop)?;
                    (property_name(key) == Some(name)).then_some(value)
                })
        })
        .flatten()
}

pub(super) fn global(expression: P<Node>, name: &str) -> bool {
    identifier_of(expression).is_some_and(|ident| {
        ident.as_identifier().text() == name && resolve_lexical_binding(ident).is_none()
    })
}

pub(super) fn owner(node: P<Node>) -> P<Node> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if is_function_like(ancestor) || ancestor.kind() == Kind::SourceFile {
            return ancestor;
        }
        cursor = ancestor.parent();
    }
    node
}

pub(super) fn parent_expression(node: P<Node>) -> P<Node> {
    let mut current = node;
    while let Some(ancestor) = current.parent() {
        if !matches!(
            ancestor.kind(),
            Kind::ParenthesizedExpression
                | Kind::AsExpression
                | Kind::SatisfiesExpression
                | Kind::NonNullExpression
                | Kind::TypeAssertionExpression
                | Kind::ExpressionWithTypeArguments
        ) {
            break;
        }
        current = ancestor;
    }
    current
}

pub(super) fn root_identifier(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::Identifier => Some(inner),
        Kind::PropertyAccessExpression => {
            root_identifier(inner.as_property_access_expression().expression())
        }
        Kind::ElementAccessExpression => {
            root_identifier(inner.as_element_access_expression().expression())
        }
        Kind::CallExpression => root_identifier(inner.as_call_expression().expression()),
        _ => None,
    }
}

fn is_env_carrier_object(expr: P<Node>) -> bool {
    let inner = unwrap_expression(expr);
    if inner.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let prop = inner.as_property_access_expression();
    if !ast::is_identifier(prop.name()) || prop.name().as_identifier().text() != "env" {
        return false;
    }
    let recv = unwrap_expression(prop.expression());
    recv.kind() == Kind::MetaProperty
        || (ast::is_identifier(recv)
            && matches!(recv.as_identifier().text(), "process" | "Bun" | "Deno"))
}

fn is_direct_env_member_read(expr: P<Node>) -> bool {
    let mut inner = unwrap_expression(expr);
    if inner.kind() == Kind::CallExpression {
        let callee = unwrap_expression(inner.as_call_expression().expression());
        if callee.kind() == Kind::PropertyAccessExpression {
            let prop = callee.as_property_access_expression();
            if ast::is_identifier(prop.name()) {
                match prop.name().as_identifier().text() {
                    "trim" => inner = unwrap_expression(prop.expression()),
                    "get" => return is_env_carrier_object(prop.expression()),
                    _ => return false,
                }
            }
        }
    }
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            is_env_carrier_object(inner.as_property_access_expression().expression())
        }
        Kind::ElementAccessExpression => {
            is_env_carrier_object(inner.as_element_access_expression().expression())
        }
        _ => false,
    }
}

fn variable_decl_binds_env(decl_node: P<Node>, target_name: &str) -> bool {
    let Some(decl) = (decl_node.kind() == Kind::VariableDeclaration)
        .then(|| decl_node.as_variable_declaration())
    else {
        return false;
    };
    let Some(init) = decl.initializer() else {
        return false;
    };
    if ast::is_identifier(decl.name()) && decl.name().as_identifier().text() == target_name {
        return is_direct_env_member_read(init);
    }
    decl.name().kind() == Kind::ObjectBindingPattern
        && is_env_carrier_object(init)
        && decl
            .name()
            .as_binding_pattern()
            .elements()
            .nodes()
            .iter()
            .any(|&e| {
                binding_property(e).is_some_and(|(_, val)| {
                    ast::is_identifier(val) && val.as_identifier().text() == target_name
                })
            })
}

fn declares_env_binding(scope: P<Node>, target_name: &str) -> bool {
    let mut found = false;
    scope.for_each_child(&mut |child| {
        if !found && !is_function_like(child) {
            found = variable_decl_binds_env(child, target_name)
                || declares_env_binding(child, target_name);
        }
        found
    });
    found
}

pub(super) fn is_env_read_expression(scope: P<Node>, expr: P<Node>) -> bool {
    if is_direct_env_member_read(expr) {
        return true;
    }
    let mut inner = unwrap_expression(expr);
    if inner.kind() == Kind::CallExpression {
        let callee = unwrap_expression(inner.as_call_expression().expression());
        if callee.kind() == Kind::PropertyAccessExpression {
            let prop = callee.as_property_access_expression();
            if ast::is_identifier(prop.name()) && prop.name().as_identifier().text() == "trim" {
                inner = unwrap_expression(prop.expression());
            }
        }
    }
    ast::is_identifier(inner) && declares_env_binding(scope, inner.as_identifier().text())
}

fn is_runtime_lookup_key(arg: P<Node>) -> bool {
    if is_direct_env_member_read(arg) {
        return true;
    }
    if arg.kind() == Kind::PropertyAccessExpression {
        let prop = arg.as_property_access_expression();
        let recv = unwrap_expression(prop.expression());
        return ast::is_identifier(recv)
            && recv.as_identifier().text() == "process"
            && ast::is_identifier(prop.name())
            && matches!(prop.name().as_identifier().text(), "platform" | "arch");
    }
    false
}

fn has_record_presence_guard(sf: P<SourceFile>, node: P<Node>, rec_name: &str) -> bool {
    let mut curr = node.parent();
    while let Some(anc) = curr {
        let guard_cond = match anc.kind() {
            Kind::ConditionalExpression => Some(anc.as_conditional_expression().condition()),
            Kind::IfStatement => Some(anc.as_if_statement().expression()),
            _ => None,
        };
        if guard_cond.is_some_and(|c| node_text(sf, c).contains(rec_name)) {
            return true;
        }
        if is_function_like(anc) || anc.kind() == Kind::SourceFile {
            let start = usize::try_from(Span::of(sf, anc).start).unwrap_or(0);
            let end = usize::try_from(Span::of(sf, node).start).unwrap_or(0);
            let before = sf.text().get(start..end).unwrap_or("");
            return before.contains(&format!("in {rec_name}"))
                || before.contains(&format!("hasOwn({rec_name}"))
                || before.contains(&format!("!{rec_name}["));
        }
        curr = anc.parent();
    }
    false
}

pub(super) fn unguarded_template_record_lookup(
    sf: P<SourceFile>,
    template_node: P<Node>,
) -> Option<P<Node>> {
    for &span in template_node
        .as_template_expression()
        .template_spans()
        .nodes()
    {
        let expr = unwrap_expression(span.as_template_span().expression());
        if expr.kind() != Kind::ElementAccessExpression {
            continue;
        }
        let ea = expr.as_element_access_expression();
        let recv = unwrap_expression(ea.expression());
        let arg = unwrap_expression(ea.argument_expression());
        if ast::is_identifier(recv)
            && is_runtime_lookup_key(arg)
            && !has_record_presence_guard(sf, template_node, recv.as_identifier().text())
        {
            return Some(expr);
        }
    }
    None
}

fn platform_bucket(lit: &str) -> Option<&'static str> {
    match lit {
        "glibc" | "gnu" | "musl" => Some("libc"),
        "linux" | "darwin" | "win32" | "freebsd" => Some("os"),
        "x64" | "arm64" | "ia32" | "x86_64" | "aarch64" => Some("arch"),
        _ => None,
    }
}

fn is_platform_probe_condition(sf: P<SourceFile>, cond: P<Node>) -> bool {
    let text = node_text(sf, cond);
    [
        "process.platform",
        "process.arch",
        "glibcVersion",
        "process.report",
        "os.platform",
        "os.arch",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn string_literal_text(node: P<Node>) -> Option<&'static str> {
    let expr = unwrap_expression(node);
    matches!(
        expr.kind(),
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
    )
    .then(|| cooked_text(expr))
    .flatten()
}

fn single_return_string_literal(stmt: P<Node>) -> Option<&'static str> {
    let ret = match stmt.kind() {
        Kind::Block => match stmt.as_block().statements().nodes() {
            &[only] => only,
            _ => return None,
        },
        _ => stmt,
    };
    (ret.kind() == Kind::ReturnStatement)
        .then(|| ret.as_return_statement().expression())
        .flatten()
        .and_then(string_literal_text)
}

fn same_platform_pair(a: &str, b: &str) -> bool {
    a != b && platform_bucket(a).is_some() && platform_bucket(a) == platform_bucket(b)
}

pub(super) fn two_branch_platform_selector(sf: P<SourceFile>, node: P<Node>) -> Option<P<Node>> {
    if node.kind() == Kind::ConditionalExpression {
        let cond = (node
            .parent()
            .is_none_or(|p| p.kind() != Kind::ConditionalExpression))
        .then(|| node.as_conditional_expression())
        .filter(|c| is_platform_probe_condition(sf, c.condition()))?;
        return same_platform_pair(
            string_literal_text(cond.when_true())?,
            string_literal_text(cond.when_false())?,
        )
        .then_some(node);
    }
    let if_stmt = (node.kind() == Kind::IfStatement)
        .then(|| node.as_if_statement())
        .filter(|s| is_platform_probe_condition(sf, s.expression()))?;
    let then_lit = single_return_string_literal(if_stmt.then_statement())?;
    if let Some(else_stmt) = if_stmt.else_statement() {
        return same_platform_pair(then_lit, single_return_string_literal(else_stmt)?)
            .then_some(node);
    }
    let stmts = node
        .parent()
        .filter(|p| p.kind() == Kind::Block)?
        .as_block()
        .statements()
        .nodes();
    (stmts.len() == 2
        && stmts[0] == node
        && same_platform_pair(then_lit, single_return_string_literal(stmts[1])?))
    .then_some(node)
}
