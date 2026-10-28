use super::web_provenance::{
    AliasStability, const_initializer, member_expression, member_object, static_property_name,
    static_string, symbol_for, unwrap_expression,
};
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-auth-token-in-web-storage";

pub struct NoAuthTokenInWebStorage {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAuthTokenInWebStorage = NoAuthTokenInWebStorage {
    scope: RuleScope::DEFAULT,
};

impl NoAuthTokenInWebStorage {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::BinaryExpression),
];

impl Rule for NoAuthTokenInWebStorage {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
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
        return Some(name.to_string());
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
            return symbol_for(expression).is_none();
        }
        let Some(symbol) = symbol_for(expression) else {
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
            return symbol_for(expression).is_none();
        }
        let Some(symbol) = symbol_for(expression) else {
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
