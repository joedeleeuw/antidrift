use super::require_stable_snapshot::callee_hook_name;
use antidrift_kernel::jsx::{
    is_hook_name, is_pascal_case_name, plain_attribute_name, react_function_name,
};
use antidrift_kernel::tsrs_kernel::{is_function_like, property_name_text, unwrap_expression};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;

const EXEMPT_LAZY_HOOKS: [&str; 6] = [
    "useState",
    "useMemo",
    "useCallback",
    "useEffect",
    "useLayoutEffect",
    "useInsertionEffect",
];

pub(super) fn reactive_primitive_name(node: P<Node>) -> Option<&'static str> {
    if node.kind() == Kind::CallExpression {
        return reactive_call_primitive_name(node);
    }
    if node.kind() == Kind::NewExpression {
        return reactive_new_primitive_name(node);
    }
    None
}

fn reactive_call_primitive_name(node: P<Node>) -> Option<&'static str> {
    let callee = unwrap_expression(node.as_call_expression().expression());
    if ast::is_identifier(callee) && callee.as_identifier().text() == "createContext" {
        return Some("createContext");
    }
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = callee.as_property_access_expression();
    let obj = unwrap_expression(access.expression());
    if !ast::is_identifier(obj) {
        return None;
    }
    match (
        obj.as_identifier().text(),
        property_name_text(access.name())?,
    ) {
        ("React", "createContext") => Some("createContext"),
        ("Atom", "make") => Some("Atom.make"),
        ("Atom", "family") => Some("Atom.family"),
        _ => None,
    }
}

fn reactive_new_primitive_name(node: P<Node>) -> Option<&'static str> {
    let callee = unwrap_expression(node.as_new_expression().expression());
    if ast::is_identifier(callee) && callee.as_identifier().text() == "QueryClient" {
        return Some("QueryClient");
    }
    if callee.kind() == Kind::PropertyAccessExpression
        && property_name_text(callee.as_property_access_expression().name()) == Some("QueryClient")
    {
        return Some("QueryClient");
    }
    None
}

fn is_exempt_lazy_hook_call(call_node: P<Node>, callback_node: P<Node>) -> bool {
    if !matches!(
        callback_node.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) {
        return false;
    }
    let Some(hook_name) = callee_hook_name(call_node.as_call_expression().expression()) else {
        return false;
    };
    EXEMPT_LAZY_HOOKS.contains(&hook_name)
        && call_node
            .as_call_expression()
            .arguments()
            .nodes()
            .contains(&callback_node)
}

fn is_jsx_event_handler(node: P<Node>) -> bool {
    node.kind() == Kind::JsxExpression
        && node.parent().is_some_and(|parent| {
            parent.kind() == Kind::JsxAttribute
                && plain_attribute_name(parent).is_some_and(|attr| {
                    attr.strip_prefix("on")
                        .and_then(|rest| rest.chars().next())
                        .is_some_and(|ch| ch.is_ascii_uppercase())
                })
        })
}

pub(super) fn is_inside_render_body(node: P<Node>) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        if parent.kind() == Kind::CallExpression && is_exempt_lazy_hook_call(parent, current) {
            return false;
        }
        if is_jsx_event_handler(parent) {
            return false;
        }
        if is_function_like(parent) {
            if ast::has_syntactic_modifier(parent, ModifierFlags::Async) {
                return false;
            }
            if let Some(fn_name) = react_function_name(parent) {
                return is_pascal_case_name(fn_name) || is_hook_name(fn_name);
            }
            if let Some(grand) = parent.parent()
                && grand.kind() == Kind::CallExpression
                && is_exempt_lazy_hook_call(grand, parent)
            {
                return false;
            }
        }
        current = parent;
    }
    false
}
