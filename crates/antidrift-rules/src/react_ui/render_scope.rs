use super::no_impure_render_call::callee_simple_name;
use antidrift_kernel::jsx::{
    is_component_or_hook_function, is_event_handler_name, plain_attribute_name, react_function_name,
};
use antidrift_kernel::tsrs_kernel::{
    Span, is_function_like, property_name_text, unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::Ctx;

const EXEMPT_HOOK_CALLBACKS: [&str; 5] = [
    "useEffect",
    "useLayoutEffect",
    "useInsertionEffect",
    "useCallback",
    "useMemo",
];
const FIRST_ARG_EXEMPT_CALLS: [&str; 6] = [
    "useState",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "queueMicrotask",
    "setImmediate",
];

fn is_hook_callback_container(call_node: P<Node>, candidate_fn: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let Some(callee_name) = callee_simple_name(call.expression()) else {
        return false;
    };
    let args = call.arguments().nodes();
    if EXEMPT_HOOK_CALLBACKS.contains(&callee_name) && args.contains(&candidate_fn) {
        return true;
    }
    FIRST_ARG_EXEMPT_CALLS.contains(&callee_name) && args.first().copied() == Some(candidate_fn)
}

fn is_event_handler_container(parent: P<Node>) -> bool {
    match parent.kind() {
        Kind::JsxAttribute => plain_attribute_name(parent).is_some_and(is_event_handler_name),
        Kind::JsxExpression => parent
            .parent()
            .filter(|grand| grand.kind() == Kind::JsxAttribute)
            .and_then(plain_attribute_name)
            .is_some_and(is_event_handler_name),
        Kind::PropertyAssignment => property_name_text(parent.as_property_assignment().name())
            .is_some_and(is_event_handler_name),
        _ => false,
    }
}

pub(super) fn is_exempt_function_scope(candidate_fn: P<Node>) -> bool {
    if ast::has_syntactic_modifier(candidate_fn, ModifierFlags::Async) {
        return true;
    }
    if react_function_name(candidate_fn).is_some_and(is_event_handler_name) {
        return true;
    }
    let Some(parent) = candidate_fn.parent() else {
        return false;
    };
    if parent.kind() == Kind::CallExpression && is_hook_callback_container(parent, candidate_fn) {
        return true;
    }
    is_event_handler_container(parent)
}

fn is_inside_parameter_default(start_node: P<Node>, function_node: P<Node>) -> bool {
    let mut current = Some(start_node);
    while let Some(node) = current {
        if node == function_node {
            return false;
        }
        if node.kind() == Kind::Parameter && node.parent() == Some(function_node) {
            return true;
        }
        current = node.parent();
    }
    false
}

pub(super) fn find_calling_render_function(
    ctx: &Ctx,
    helper_fn: P<Node>,
    visited: &mut FxHashSet<Span>,
) -> Option<P<Node>> {
    let helper_name = react_function_name(helper_fn)?;
    let mut result = None;
    find_call_to_helper(ctx, ctx.file.as_node(), helper_name, visited, &mut result);
    result
}

fn find_call_to_helper(
    ctx: &Ctx,
    node: P<Node>,
    helper_name: &str,
    visited: &mut FxHashSet<Span>,
    result: &mut Option<P<Node>>,
) {
    if result.is_some() {
        return;
    }
    if node.kind() == Kind::CallExpression {
        let callee = unwrap_expression(node.as_call_expression().expression());
        if ast::is_identifier(callee)
            && callee.as_identifier().text() == helper_name
            && let Some(enclosing) = find_enclosing_render_function(ctx, node, visited)
        {
            *result = Some(enclosing);
            return;
        }
    }
    node.for_each_child(&mut |child| {
        find_call_to_helper(ctx, child, helper_name, visited, result);
        result.is_some()
    });
}

pub(super) fn find_enclosing_render_function(
    ctx: &Ctx,
    start_node: P<Node>,
    visited: &mut FxHashSet<Span>,
) -> Option<P<Node>> {
    let mut current = start_node.parent();
    while let Some(node) = current {
        if is_function_like(node) {
            if is_inside_parameter_default(start_node, node) || is_exempt_function_scope(node) {
                return None;
            }
            if is_component_or_hook_function(node) {
                return Some(node);
            }
            let span = Span::of(ctx.file, node);
            if visited.insert(span) {
                return find_calling_render_function(ctx, node, visited);
            }
            return None;
        }
        current = node.parent();
    }
    None
}
