use super::syntax::{
    Binding, binding_property, const_initializer, declaration, global, identifier, is_const_decl,
    member, symbol, unwrap,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

#[derive(Clone, Copy)]
enum StreamType {
    Response,
    ReadableStream,
}

impl StreamType {
    fn name(self) -> &'static str {
        match self {
            Self::Response => "Response",
            Self::ReadableStream => "ReadableStream",
        }
    }
}

pub(super) fn is_stream(expression: P<Node>) -> bool {
    has_origin(
        expression,
        StreamType::ReadableStream,
        &mut FxHashSet::default(),
    )
}

fn is_null_or_undefined_type(part: P<Node>) -> bool {
    matches!(part.kind(), Kind::NullKeyword | Kind::UndefinedKeyword)
        || (part.kind() == Kind::LiteralType
            && part.as_literal_type_node().literal().kind() == Kind::NullKeyword)
}

fn named_type(annotation: P<Node>, expected: StreamType) -> bool {
    match annotation.kind() {
        Kind::ParenthesizedType => {
            named_type(annotation.as_parenthesized_type_node().type_(), expected)
        }
        Kind::UnionType => {
            let mut meaningful = annotation
                .as_union_type_node()
                .types()
                .nodes()
                .iter()
                .copied()
                .filter(|&part| !is_null_or_undefined_type(part));
            meaningful
                .next()
                .is_some_and(|first| named_type(first, expected))
                && meaningful.all(|part| named_type(part, expected))
        }
        Kind::TypeReference => {
            let type_name = annotation.as_type_reference_node().type_name();
            ast::is_identifier(type_name)
                && type_name.as_identifier().text() == expected.name()
                && symbol(type_name).is_none()
        }
        _ => false,
    }
}

fn binding_type(binding: Binding, expected: StreamType) -> bool {
    let annotation = match binding.decl.kind() {
        Kind::VariableDeclaration => binding.decl.as_variable_declaration().type_(),
        Kind::Parameter => binding.decl.as_parameter_declaration().type_(),
        _ => None,
    };
    annotation.is_some_and(|ty| named_type(ty, expected))
}

fn constructor(expression: P<Node>, expected: StreamType) -> bool {
    let inner = unwrap(expression);
    if inner.kind() != Kind::NewExpression {
        return false;
    }
    global_host(inner.as_new_expression().expression(), expected.name())
}

pub(super) fn global_host(expression: P<Node>, name: &str) -> bool {
    global(expression, name)
        || member(expression).is_some_and(|(host, method)| {
            method == name
                && ["globalThis", "self", "window"]
                    .iter()
                    .any(|host_name| global(host, host_name))
        })
}

fn has_origin(expression: P<Node>, expected: StreamType, visited: &mut FxHashSet<Binding>) -> bool {
    let inner = unwrap(expression);
    if constructor(inner, expected) {
        return true;
    }
    match (expected, inner.kind()) {
        (StreamType::Response, Kind::AwaitExpression) => {
            let arg = unwrap(inner.as_await_expression().expression());
            return arg.kind() == Kind::CallExpression
                && global_host(arg.as_call_expression().expression(), "fetch");
        }
        (StreamType::ReadableStream, Kind::CallExpression)
            if inner.as_call_expression().arguments().nodes().is_empty() =>
        {
            if let Some((stdin, "stream")) = member(inner.as_call_expression().expression())
                && let Some((bun, "stdin")) = member(stdin)
                && global(bun, "Bun")
            {
                return true;
            }
        }
        (StreamType::ReadableStream, _) => {
            if let Some((response, "body")) = member(inner) {
                return has_origin(response, StreamType::Response, &mut FxHashSet::default());
            }
        }
        _ => {}
    }
    let Some(ident) = identifier(inner) else {
        return false;
    };
    let Some(binding) = symbol(ident) else {
        return false;
    };
    if !visited.insert(binding) {
        return false;
    }
    if binding_type(binding, expected) {
        return true;
    }
    if matches!(expected, StreamType::ReadableStream) && destructured_body(binding) {
        return true;
    }
    const_initializer(binding).is_some_and(|initializer| has_origin(initializer, expected, visited))
}

fn destructured_body(binding: Binding) -> bool {
    let Some(decl) = declaration(binding) else {
        return false;
    };
    if !is_const_decl(decl) {
        return false;
    }
    let Some(pattern) = decl.name() else {
        return false;
    };
    if pattern.kind() != Kind::ObjectBindingPattern {
        return false;
    }
    let body_binding = pattern
        .as_binding_pattern()
        .elements()
        .nodes()
        .iter()
        .any(|&elem| {
            binding_property(elem).is_some_and(|(key, value)| {
                key == "body"
                    && ast::is_identifier(value)
                    && value.pos() == binding.ident.pos()
                    && value.end() == binding.ident.end()
            })
        });
    body_binding
        && decl
            .as_variable_declaration()
            .initializer()
            .is_some_and(|initializer| {
                has_origin(initializer, StreamType::Response, &mut FxHashSet::default())
            })
}

pub(super) fn canonical(expression: P<Node>) -> Option<Binding> {
    let mut binding = symbol(identifier(expression)?)?;
    let mut visited = FxHashSet::default();
    while visited.insert(binding) {
        let Some(aliased) = const_initializer(binding)
            .and_then(identifier)
            .and_then(symbol)
        else {
            break;
        };
        binding = aliased;
    }
    Some(binding)
}
