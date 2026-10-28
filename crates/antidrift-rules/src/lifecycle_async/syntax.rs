pub(super) use antidrift_kernel::local_binding::{
    Binding, binding_for_declarator, collect_binding_references as references_to,
    const_binding_initializer as const_initializer, enclosing_variable_declaration as declaration,
    is_binding_mutated as symbol_is_mutated, is_const_variable_declaration as is_const_decl,
    is_let_variable_declaration as is_let_decl, is_var_variable_declaration as is_var_decl,
    is_write_reference, resolve_lexical_binding as symbol,
};
use antidrift_kernel::rule_scope::RuleScope;
pub(super) use antidrift_kernel::tsrs_kernel::{
    is_function_like as is_function, unwrap_expression as unwrap,
    unwrap_parentheses as without_parens,
};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::Ctx;
use tsrslint::utils::trim_node_text_range;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Span {
    pub(super) start: i32,
    pub(super) end: i32,
}

impl Span {
    pub(super) fn of(sf: P<SourceFile>, node: P<Node>) -> Self {
        let (start, end) = trim_node_text_range(sf, node);
        Self { start, end }
    }

    pub(super) fn contains_inclusive(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }
}

pub(super) fn in_scope(ctx: &Ctx<'_>, scope: &RuleScope) -> bool {
    let cwd = ctx.program.host().get_current_directory();
    let filename = ctx.file.file_name().replace('\\', "/");
    scope.matches(&filename, cwd)
}

pub(super) fn identifier(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap(expression);
    ast::is_identifier(inner).then_some(inner)
}

pub(super) fn member(expression: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = unwrap(expression);
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
            let arg = unwrap(access.argument_expression());
            if ast::is_string_literal(arg) {
                Some((access.expression(), arg.as_string_literal().text()))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn identifier_member(expression: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = without_parens(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name_node = access.name();
            ast::is_identifier(name_node)
                .then(|| (access.expression(), name_node.as_identifier().text()))
        }
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            let arg = without_parens(access.argument_expression());
            ast::is_identifier(arg).then(|| (access.expression(), arg.as_identifier().text()))
        }
        _ => None,
    }
}

pub(super) fn property_name(key: P<Node>) -> Option<&'static str> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => Some(key.as_string_literal().text()),
        Kind::ComputedPropertyName => {
            let expr = without_parens(key.as_computed_property_name().expression());
            match expr.kind() {
                Kind::Identifier => Some(expr.as_identifier().text()),
                Kind::StringLiteral => Some(expr.as_string_literal().text()),
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

pub(super) fn call_expression(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap(expression);
    (inner.kind() == Kind::CallExpression).then_some(inner)
}

pub(super) fn property(expression: P<Node>, name: &str) -> Option<P<Node>> {
    let inner = unwrap(expression);
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
    identifier(expression)
        .is_some_and(|ident| ident.as_identifier().text() == name && symbol(ident).is_none())
}

pub(super) fn owner(node: P<Node>) -> P<Node> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if is_function(ancestor) || ancestor.kind() == Kind::SourceFile {
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
    let inner = unwrap(expression);
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
