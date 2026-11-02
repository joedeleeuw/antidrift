pub(super) use antidrift_kernel::local_binding::{
    Binding, binding_for_declarator, collect_binding_references, const_binding_initializer,
    enclosing_variable_declaration, is_binding_mutated, is_const_variable_declaration,
    is_let_variable_declaration, is_var_variable_declaration, is_write_reference,
    resolve_lexical_binding,
};
pub(super) use antidrift_kernel::tsrs_kernel::{
    Span, call_expression_of, cooked_text, identifier_of, is_function_like, unwrap_expression,
    unwrap_parentheses,
};
use tsrs_ast::{self as ast, Kind, Node};
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
    if elem.kind() != Kind::BindingElement {
        return None;
    }
    let binding = elem.as_binding_element();
    if binding.dot_dot_dot_token().is_some() {
        return None;
    }
    let value = binding.name()?;
    let key_node = binding.property_name().unwrap_or(value);
    let key = property_name(key_node)?;
    Some((key, value))
}

pub(super) fn property(expression: P<Node>, name: &str) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    if inner.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    for &prop in inner.as_object_literal_expression().properties().nodes() {
        if let Some((key, value, _)) = object_property(prop)
            && property_name(key) == Some(name)
        {
            return Some(value);
        }
    }
    None
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
    if recv.kind() == Kind::MetaProperty {
        return true;
    }
    ast::is_identifier(recv) && matches!(recv.as_identifier().text(), "process" | "Bun" | "Deno")
}

fn is_direct_env_member_read(expr: P<Node>) -> bool {
    let mut inner = unwrap_expression(expr);
    if inner.kind() == Kind::CallExpression {
        let call = inner.as_call_expression();
        let callee = unwrap_expression(call.expression());
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

fn is_binding_element_for_name(elem: P<Node>, target_name: &str) -> bool {
    binding_property(elem).is_some_and(|(_, val)| {
        ast::is_identifier(val) && val.as_identifier().text() == target_name
    })
}

fn variable_decl_binds_env(decl_node: P<Node>, target_name: &str) -> bool {
    if decl_node.kind() != Kind::VariableDeclaration {
        return false;
    }
    let decl = decl_node.as_variable_declaration();
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
            .any(|&e| is_binding_element_for_name(e, target_name))
}

fn declares_env_binding(scope: P<Node>, target_name: &str) -> bool {
    let mut found = false;
    scope.for_each_child(&mut |child| {
        if found || is_function_like(child) {
            return found;
        }
        if variable_decl_binds_env(child, target_name) {
            found = true;
            return true;
        }
        found = declares_env_binding(child, target_name);
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
