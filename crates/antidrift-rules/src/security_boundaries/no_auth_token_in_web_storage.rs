use super::web_provenance::{
    AliasStability, const_initializer, member_expression, member_object, resolve_lexical_binding,
    static_property_name, static_string, unwrap_expression,
};
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

pub const RULE_NAME: &str = "antidrift/no-auth-token-in-web-storage";

pub static DEFAULT_RULE: RuleSpec = RuleSpec::new(RULE_NAME, LISTENERS, visit);

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::BinaryExpression),
];

fn visit(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if node.kind() == Kind::BinaryExpression
        && let Some(env_key) = non_constant_time_secret_env_compare(ctx.file, node)
    {
        ctx.report_node(
            node,
            RuleMessage::new(
                "nonConstantTimeSecretCompare",
                format!(
                    "Do not compare secret env variable '{env_key}' with '===' or '!=='; use crypto.timingSafeEqual on equal-length buffers to prevent timing side-channels."
                ),
            ),
        );
        return;
    }
    let key = match node.kind() {
        Kind::CallExpression => credential_call(ctx.file, node),
        Kind::BinaryExpression => credential_assignment(ctx.file, node),
        _ => None,
    };
    if key.is_some_and(|key| credential_key(&key)) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "noAuthTokenInWebStorage",
                "Do not store authentication credentials in localStorage or sessionStorage; any script running in the page can read and exfiltrate them. Use a server-set HttpOnly, Secure, SameSite cookie instead.",
            ),
        );
    }
}

fn is_nullish_or_empty_literal(sf: P<SourceFile>, expr: P<Node>) -> bool {
    let inner = unwrap_expression(expr);
    inner.kind() == Kind::NullKeyword
        || (ast::is_identifier(inner) && inner.as_identifier().text() == "undefined")
        || static_string(sf, inner, &mut Vec::new()).is_some_and(|s| s.is_empty())
}

fn env_secret_key_from_expr(sf: P<SourceFile>, expr: P<Node>, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    let mut inner = unwrap_expression(expr);
    if inner.kind() == Kind::CallExpression {
        let call = inner.as_call_expression();
        let member = member_expression(call.expression())?;
        if member_name(sf, member).as_deref() == Some("trim") {
            inner = unwrap_expression(member_object(member));
        }
    }
    if ast::is_identifier(inner) {
        let binding = resolve_lexical_binding(inner)?;
        let init = const_initializer(sf, binding, AliasStability::Const)?;
        return env_secret_key_from_expr(sf, init, depth + 1);
    }
    let member = member_expression(inner)?;
    let env_obj = member_expression(member_object(member))?;
    if member_name(sf, env_obj).as_deref() != Some("env") {
        return None;
    }
    let key = member_name(sf, member)?;
    let upper = key.to_ascii_uppercase();
    (["KEY", "TOKEN", "SECRET", "CREDENTIAL"]
        .iter()
        .any(|marker| upper.contains(marker)))
    .then_some(key)
}

fn non_constant_time_secret_env_compare(sf: P<SourceFile>, node: P<Node>) -> Option<String> {
    let bin = node.as_binary_expression();
    if !matches!(
        bin.operator_token().kind(),
        Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken
    ) {
        return None;
    }
    if is_nullish_or_empty_literal(sf, bin.left()) || is_nullish_or_empty_literal(sf, bin.right()) {
        return None;
    }
    env_secret_key_from_expr(sf, bin.left(), 0)
        .or_else(|| env_secret_key_from_expr(sf, bin.right(), 0))
}

fn credential_assignment(sf: P<SourceFile>, node: P<Node>) -> Option<String> {
    let bin = node.as_binary_expression();
    if !ast::is_assignment_operator(bin.operator_token().kind()) {
        return None;
    }
    let member = member_expression(bin.left())?;
    if is_web_storage(sf, member_object(member), &mut Vec::new()) {
        member_name(sf, member)
    } else {
        None
    }
}

fn credential_call(sf: P<SourceFile>, call_node: P<Node>) -> Option<String> {
    let call = call_node.as_call_expression();
    let member = member_expression(call.expression())?;
    let args = call.arguments().nodes();
    if member_name(sf, member).as_deref() != Some("setItem")
        || args.len() < 2
        || !is_web_storage(sf, member_object(member), &mut Vec::new())
    {
        return None;
    }
    let first = *args.first()?;
    if first.kind() == Kind::SpreadElement {
        return None;
    }
    static_string(sf, first, &mut Vec::new())
}

fn member_name(sf: P<SourceFile>, member: P<Node>) -> Option<String> {
    if let Some(name) = static_property_name(member) {
        return Some(name.to_owned());
    }
    if member.kind() == Kind::ElementAccessExpression {
        return static_string(
            sf,
            member.as_element_access_expression().argument_expression(),
            &mut Vec::new(),
        );
    }
    None
}

fn is_web_storage(sf: P<SourceFile>, expression: P<Node>, visited: &mut Vec<Binding>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        let name = expression.as_identifier().text();
        if matches!(name, "localStorage" | "sessionStorage") {
            return resolve_lexical_binding(expression).is_none();
        }
        let Some(symbol) = resolve_lexical_binding(expression) else {
            return false;
        };
        if visited.contains(&symbol) {
            return false;
        }
        visited.push(symbol);
        return const_initializer(sf, symbol, AliasStability::Const)
            .is_some_and(|initializer| is_web_storage(sf, initializer, visited));
    }
    member_expression(expression).is_some_and(|member| {
        matches!(
            member_name(sf, member).as_deref(),
            Some("localStorage" | "sessionStorage")
        ) && browser_host(sf, member_object(member), &mut Vec::new())
    })
}

fn browser_host(sf: P<SourceFile>, expression: P<Node>, visited: &mut Vec<Binding>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        let name = expression.as_identifier().text();
        if matches!(name, "window" | "globalThis" | "self") {
            return resolve_lexical_binding(expression).is_none();
        }
        let Some(symbol) = resolve_lexical_binding(expression) else {
            return false;
        };
        if visited.contains(&symbol) {
            return false;
        }
        visited.push(symbol);
        return const_initializer(sf, symbol, AliasStability::Const)
            .is_some_and(|initializer| browser_host(sf, initializer, visited));
    }
    member_expression(expression).is_some_and(|member| {
        matches!(
            member_name(sf, member).as_deref(),
            Some("window" | "globalThis" | "self")
        ) && browser_host(sf, member_object(member), visited)
    })
}

fn credential_key(key: &str) -> bool {
    let key = key.to_lowercase();
    let credential = [
        "token",
        "jwt",
        "secret",
        "password",
        "passwd",
        "credential",
        "bearer",
    ]
    .iter()
    .any(|part| key.contains(part))
        || joined_key(&key, "api", "key")
        || joined_key(&key, "private", "key");
    if !credential {
        return false;
    }
    let non_credential = [
        "csrf", "xsrf", "device", "fcm", "apns", "push", "design", "tokeniz", "syntax", "css",
        "theme", "color",
    ]
    .iter()
    .any(|part| key.contains(part));
    let strong = [
        "jwt",
        "secret",
        "password",
        "passwd",
        "credential",
        "bearer",
        "session",
    ]
    .iter()
    .any(|part| key.contains(part))
        || ["api", "private"]
            .iter()
            .any(|prefix| joined_key(&key, prefix, "key"))
        || ["access", "refresh", "auth", "id"]
            .iter()
            .any(|prefix| joined_key(&key, prefix, "token"));
    !non_credential || strong
}

fn joined_key(key: &str, prefix: &str, suffix: &str) -> bool {
    ["", "-", "_"]
        .iter()
        .any(|separator| key.contains(&format!("{prefix}{separator}{suffix}")))
}
