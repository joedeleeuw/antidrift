pub(super) use antidrift_kernel::file_role::is_test_or_spec_file;
pub(super) use antidrift_kernel::tsrs_kernel::{
    Span, call_expression_of, identifier_of, member_chain_root_node, member_object,
    numeric_literal_value, unwrap_awaited_expression, unwrap_expression,
};
use tsrs_ast::{Kind, Node, SourceFile};
use tsrs_core::P;

pub(super) fn member(expression: P<Node>) -> Option<(P<Node>, String)> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name = access.name();
            match name.kind() {
                Kind::Identifier => {
                    Some((access.expression(), name.as_identifier().text().to_owned()))
                }
                Kind::PrivateIdentifier => Some((
                    access.expression(),
                    name.as_private_identifier().text().to_owned(),
                )),
                _ => None,
            }
        }
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            segment(access.argument_expression()).map(|name| (access.expression(), name))
        }
        _ => None,
    }
}

pub(super) fn static_member(expression: P<Node>) -> Option<(P<Node>, String)> {
    let pair = member(expression)?;
    let inner = unwrap_expression(expression);
    let numeric = inner.kind() == Kind::ElementAccessExpression
        && unwrap_expression(inner.as_element_access_expression().argument_expression()).kind()
            == Kind::NumericLiteral;
    (!numeric).then_some(pair)
}

pub(super) fn segment(expression: P<Node>) -> Option<String> {
    match expression.kind() {
        Kind::StringLiteral => Some(expression.as_string_literal().text().to_owned()),
        Kind::NumericLiteral => numeric_literal_value(expression).map(|val| val.to_string()),
        _ => None,
    }
}

pub(super) fn object_property(prop: P<Node>) -> Option<(String, P<Node>, bool)> {
    match prop.kind() {
        Kind::PropertyAssignment => {
            let assign = prop.as_property_assignment();
            let key = assign.name();
            let computed = key.kind() == Kind::ComputedPropertyName;
            let name = property_name(key, computed)?;
            Some((name, assign.initializer(), computed))
        }
        Kind::ShorthandPropertyAssignment => {
            let short = prop.as_shorthand_property_assignment();
            let key = short.name();
            let name = property_name(key, false)?;
            Some((name, key, false))
        }
        _ => None,
    }
}

pub(super) fn property_name(key: P<Node>, computed: bool) -> Option<String> {
    match key.kind() {
        Kind::Identifier if !computed => Some(key.as_identifier().text().to_owned()),
        Kind::StringLiteral => Some(key.as_string_literal().text().to_owned()),
        Kind::NumericLiteral => numeric_literal_value(key).map(|val| val.to_string()),
        Kind::ComputedPropertyName => {
            let inner = key.as_computed_property_name().expression();
            match inner.kind() {
                Kind::StringLiteral => Some(inner.as_string_literal().text().to_owned()),
                Kind::NumericLiteral => numeric_literal_value(inner).map(|val| val.to_string()),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(super) fn argument(call_node: P<Node>, index: usize) -> Option<P<Node>> {
    let arg = *call_node
        .as_call_expression()
        .arguments()
        .nodes()
        .get(index)?;
    (arg.kind() != Kind::SpreadElement).then_some(arg)
}

pub(super) fn root_identifier(expression: P<Node>) -> Option<P<Node>> {
    member_chain_root_node(unwrap_awaited_expression(expression))
}

pub(super) fn literal_container(expression: P<Node>) -> bool {
    matches!(
        unwrap_expression(expression).kind(),
        Kind::ObjectLiteralExpression
            | Kind::ArrayLiteralExpression
            | Kind::StringLiteral
            | Kind::NumericLiteral
            | Kind::TrueKeyword
            | Kind::FalseKeyword
            | Kind::NullKeyword
            | Kind::BigIntLiteral
            | Kind::RegularExpressionLiteral
            | Kind::NoSubstitutionTemplateLiteral
            | Kind::TemplateExpression
    )
}

pub(super) fn literal(expression: P<Node>) -> bool {
    let inner = unwrap_expression(expression);
    literal_container(inner)
        && !matches!(
            inner.kind(),
            Kind::ObjectLiteralExpression
                | Kind::ArrayLiteralExpression
                | Kind::NoSubstitutionTemplateLiteral
                | Kind::TemplateExpression
        )
}

pub(super) fn expression_key(sf: P<SourceFile>, expression: P<Node>) -> (i32, i32) {
    let span = Span::of(sf, expression);
    (span.start, span.end)
}

pub(super) fn is_test_file(filename: &str) -> bool {
    filename.is_empty()
        || matches!(filename, "<input>" | "<text>")
        || is_test_or_spec_file(filename)
}
