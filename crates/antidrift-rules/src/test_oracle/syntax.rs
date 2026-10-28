use antidrift_kernel::tsrs_kernel;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::utils::trim_node_text_range;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct Span {
    pub(super) start: i32,
    pub(super) end: i32,
}

impl Span {
    pub(super) fn of(sf: P<SourceFile>, node: P<Node>) -> Self {
        let (start, end) = trim_node_text_range(sf, node);
        Self { start, end }
    }
}

pub(super) fn unwrap(expression: P<Node>) -> P<Node> {
    tsrs_kernel::unwrap_expression(expression)
}

pub(super) fn awaited(expression: P<Node>) -> P<Node> {
    let inner = unwrap(expression);
    if inner.kind() == Kind::AwaitExpression {
        awaited(inner.as_await_expression().expression())
    } else {
        inner
    }
}

pub(super) fn identifier(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap(expression);
    ast::is_identifier(inner).then_some(inner)
}

pub(super) fn member(expression: P<Node>) -> Option<(P<Node>, String)> {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name = access.name();
            match name.kind() {
                Kind::Identifier => {
                    Some((access.expression(), name.as_identifier().text().to_string()))
                }
                Kind::PrivateIdentifier => Some((
                    access.expression(),
                    name.as_private_identifier().text().to_string(),
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

pub(super) fn member_object(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => Some(inner.as_property_access_expression().expression()),
        Kind::ElementAccessExpression => Some(inner.as_element_access_expression().expression()),
        _ => None,
    }
}

pub(super) fn static_member(expression: P<Node>) -> Option<(P<Node>, String)> {
    let pair = member(expression)?;
    let inner = unwrap(expression);
    let numeric = inner.kind() == Kind::ElementAccessExpression
        && unwrap(inner.as_element_access_expression().argument_expression()).kind()
            == Kind::NumericLiteral;
    (!numeric).then_some(pair)
}

pub(super) fn segment(expression: P<Node>) -> Option<String> {
    match expression.kind() {
        Kind::StringLiteral => Some(expression.as_string_literal().text().to_string()),
        Kind::NumericLiteral => numeric_value(expression).map(|val| val.to_string()),
        _ => None,
    }
}

pub(super) fn numeric_value(expression: P<Node>) -> Option<f64> {
    if expression.kind() != Kind::NumericLiteral {
        return None;
    }
    let Ok(value) = expression.text().replace('_', "").parse::<f64>() else {
        return None;
    };
    Some(value)
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
        Kind::Identifier if !computed => Some(key.as_identifier().text().to_string()),
        Kind::StringLiteral => Some(key.as_string_literal().text().to_string()),
        Kind::NumericLiteral => numeric_value(key).map(|val| val.to_string()),
        Kind::ComputedPropertyName => {
            let inner = key.as_computed_property_name().expression();
            match inner.kind() {
                Kind::StringLiteral => Some(inner.as_string_literal().text().to_string()),
                Kind::NumericLiteral => numeric_value(inner).map(|val| val.to_string()),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(super) fn call(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap(expression);
    (inner.kind() == Kind::CallExpression).then_some(inner)
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
    let expression = awaited(expression);
    if let Some((object, _)) = member(expression) {
        return root_identifier(object);
    }
    match expression.kind() {
        Kind::PropertyAccessExpression => {
            root_identifier(expression.as_property_access_expression().expression())
        }
        Kind::ElementAccessExpression => {
            root_identifier(expression.as_element_access_expression().expression())
        }
        _ => identifier(expression),
    }
}

pub(super) fn literal_container(expression: P<Node>) -> bool {
    matches!(
        unwrap(expression).kind(),
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
    let inner = unwrap(expression);
    literal_container(inner)
        && !matches!(
            inner.kind(),
            Kind::ObjectLiteralExpression
                | Kind::ArrayLiteralExpression
                | Kind::NoSubstitutionTemplateLiteral
                | Kind::TemplateExpression
        )
}

pub(super) fn contains(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

pub(super) fn expression_key(sf: P<SourceFile>, expression: P<Node>) -> (i32, i32) {
    let span = Span::of(sf, expression);
    (span.start, span.end)
}

pub(super) fn is_test_file(filename: &str) -> bool {
    filename.is_empty() || matches!(filename, "<input>" | "<text>") || explicit_test_file(filename)
}

pub(super) fn explicit_test_file(filename: &str) -> bool {
    let normalized = filename.replace('\\', "/");
    if normalized
        .split('/')
        .rev()
        .skip(1)
        .any(|part| matches!(part, "test" | "tests" | "__tests__"))
    {
        return true;
    }
    let Some((stem, extension)) = normalized.rsplit_once('.') else {
        return false;
    };
    matches!(
        extension,
        "js" | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "mjsx"
            | "mts"
            | "mtsx"
            | "cjs"
            | "cjsx"
            | "cts"
            | "ctsx"
    ) && (stem.ends_with(".test") || stem.ends_with(".spec"))
}
