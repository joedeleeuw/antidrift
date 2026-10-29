use antidrift_kernel::jsx::{
    is_component_or_hook_function, is_event_handler_name, plain_attribute_name, react_function_name,
};
use antidrift_kernel::provenance::{symbol_at_node, symbol_declarations};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{
    Span, function_node_from_declaration, is_function_like, is_test_file, property_name_text,
    unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_checker::{Checker, SignatureKind};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-impure-render-call";

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

pub struct NoImpureRenderCall {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoImpureRenderCall = NoImpureRenderCall {
    scope: RuleScope::DEFAULT,
};

impl NoImpureRenderCall {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::NewExpression),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::FunctionExpression),
];

impl Rule for NoImpureRenderCall {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let active = in_scope(&self.scope, ctx, None) && !is_test_file(ctx.file.file_name());
        Box::new(Visitor { active })
    }
}

struct Visitor {
    active: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.active { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::CallExpression => inspect_call_expression(ctx, node),
            Kind::NewExpression => inspect_new_expression(ctx, node),
            Kind::FunctionDeclaration | Kind::ArrowFunction | Kind::FunctionExpression => {
                inspect_function_defaults(ctx, node);
            }
            _ => {}
        }
    }
}

fn inspect_call_expression(ctx: &mut Ctx, call_node: P<Node>) {
    let Some(enclosing) = find_enclosing_render_function(ctx, call_node, &mut FxHashSet::default())
    else {
        return;
    };
    let enclosing_name = react_function_name(enclosing).unwrap_or("component");
    if let Some(impure_name) = describe_impure_call(call_node) {
        report_direct_render_call(ctx, call_node, impure_name, enclosing_name);
        return;
    }
    if let Some((callee_name, param_name, impure_name)) =
        detect_omitted_impure_default(ctx.checker, call_node)
    {
        ctx.report_node(
            call_node,
            RuleMessage::new(
                "omittedDefaultCall",
                format!(
                    "Call to '{callee_name}' evaluates impure '{impure_name}' via omitted default parameter '{param_name}' during render of '{enclosing_name}'; pass '{param_name}' explicitly or isolate to a leaf component."
                ),
            ),
        );
        return;
    }
    if let Some((callee_name, impure_name)) = detect_impure_one_hop_body(ctx.checker, call_node) {
        ctx.report_node(
            call_node,
            RuleMessage::new(
                "oneHopBodyCall",
                format!(
                    "Call to '{callee_name}' evaluates impure '{impure_name}' during render of '{enclosing_name}'; move to an effect, event handler, or derive from state/props."
                ),
            ),
        );
    }
}

fn inspect_new_expression(ctx: &mut Ctx, new_node: P<Node>) {
    let Some(enclosing) = find_enclosing_render_function(ctx, new_node, &mut FxHashSet::default())
    else {
        return;
    };
    let Some(impure_name) = describe_impure_call(new_node) else {
        return;
    };
    let enclosing_name = react_function_name(enclosing).unwrap_or("component");
    report_direct_render_call(ctx, new_node, impure_name, enclosing_name);
}

fn report_direct_render_call(
    ctx: &mut Ctx,
    node: P<Node>,
    impure_name: &str,
    enclosing_name: &str,
) {
    ctx.report_node(
        node,
        RuleMessage::new(
            "directRenderCall",
            format!(
                "Do not evaluate impure '{impure_name}' during render of '{enclosing_name}'; move to an effect, event handler, or derive from state/props."
            ),
        ),
    );
}

fn inspect_function_defaults(ctx: &mut Ctx, function_node: P<Node>) {
    if is_exempt_function_scope(function_node) {
        return;
    }
    let enclosing_render = if is_component_or_hook_function(function_node) {
        Some(function_node)
    } else {
        let mut visited = FxHashSet::default();
        visited.insert(Span::of(ctx.file, function_node));
        find_calling_render_function(ctx, function_node, &mut visited)
    };
    let Some(enclosing) = enclosing_render else {
        return;
    };
    let enclosing_name = react_function_name(enclosing).unwrap_or("component");
    for &param in function_node.parameters() {
        check_single_parameter_defaults(ctx, param, enclosing_name);
    }
}

fn check_single_parameter_defaults(ctx: &mut Ctx, param: P<Node>, enclosing_name: &str) {
    let parameter = param.as_parameter_declaration();
    if let Some(init) = parameter.initializer()
        && let Some(impure_name) = find_impure_expression_in_tree(init)
    {
        let param_name = property_name_text(parameter.name()).unwrap_or("parameter");
        report_parameter_default(ctx, init, impure_name, param_name, enclosing_name);
    }
    let name_node = parameter.name();
    if name_node.kind() != Kind::ObjectBindingPattern {
        return;
    }
    for &elem in name_node.as_binding_pattern().elements().nodes() {
        if elem.kind() != Kind::BindingElement {
            continue;
        }
        let binding_elem = elem.as_binding_element();
        if let Some(init) = binding_elem.initializer()
            && let Some(impure_name) = find_impure_expression_in_tree(init)
        {
            let prop_name = binding_elem
                .name()
                .and_then(property_name_text)
                .unwrap_or("prop");
            report_parameter_default(ctx, init, impure_name, prop_name, enclosing_name);
        }
    }
}

fn report_parameter_default(
    ctx: &mut Ctx,
    init_node: P<Node>,
    impure_name: &str,
    param_name: &str,
    enclosing_name: &str,
) {
    ctx.report_node(
        init_node,
        RuleMessage::new(
            "parameterDefault",
            format!(
                "Do not evaluate impure '{impure_name}' in default parameter '{param_name}' of '{enclosing_name}'; pass the value explicitly or initialize in an effect or useState lazy initializer."
            ),
        ),
    );
}

fn matches_receiver_identifier(expression: P<Node>, expected: &str) -> bool {
    let inner = unwrap_expression(expression);
    if ast::is_identifier(inner) {
        return inner.as_identifier().text() == expected;
    }
    if inner.kind() == Kind::PropertyAccessExpression {
        let access = inner.as_property_access_expression();
        let obj = unwrap_expression(access.expression());
        return property_name_text(access.name()) == Some(expected)
            && ast::is_identifier(obj)
            && matches!(obj.as_identifier().text(), "globalThis" | "window");
    }
    false
}

fn describe_impure_call(node: P<Node>) -> Option<&'static str> {
    if node.kind() == Kind::CallExpression {
        let call = node.as_call_expression();
        let callee = unwrap_expression(call.expression());
        if callee.kind() == Kind::PropertyAccessExpression {
            let access = callee.as_property_access_expression();
            let method = property_name_text(access.name())?;
            let recv = access.expression();
            return match method {
                "now" if matches_receiver_identifier(recv, "Date") => Some("Date.now()"),
                "random" if matches_receiver_identifier(recv, "Math") => Some("Math.random()"),
                "randomUUID" if matches_receiver_identifier(recv, "crypto") => {
                    Some("crypto.randomUUID()")
                }
                _ => None,
            };
        }
        if ast::is_identifier(callee)
            && callee.as_identifier().text() == "Date"
            && call.arguments().nodes().is_empty()
        {
            return Some("Date()");
        }
    } else if node.kind() == Kind::NewExpression {
        let new_expr = node.as_new_expression();
        let arg_count = new_expr.arguments().map_or(0, |args| args.nodes().len());
        if arg_count == 0 && matches_receiver_identifier(new_expr.expression(), "Date") {
            return Some("new Date()");
        }
    }
    None
}

fn find_impure_expression_in_tree(root: P<Node>) -> Option<&'static str> {
    if let Some(direct) = describe_impure_call(root) {
        return Some(direct);
    }
    let mut found = None;
    root.for_each_child(&mut |child| {
        if found.is_some() || is_function_like(child) {
            return true;
        }
        if let Some(impure) = find_impure_expression_in_tree(child) {
            found = Some(impure);
            return true;
        }
        false
    });
    found
}

fn callee_simple_name(callee: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(callee);
    match inner.kind() {
        Kind::Identifier => Some(inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            property_name_text(inner.as_property_access_expression().name())
        }
        _ => None,
    }
}

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

fn is_exempt_function_scope(candidate_fn: P<Node>) -> bool {
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

fn find_calling_render_function(
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

fn find_enclosing_render_function(
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

fn resolve_callee_declaration(checker: &mut Checker, call_node: P<Node>) -> Option<P<Node>> {
    let callee = unwrap_expression(call_node.as_call_expression().expression());
    let sym = symbol_at_node(checker, callee);
    for decl in symbol_declarations(checker, sym) {
        if let Some(fn_node) = function_node_from_declaration(decl) {
            return Some(fn_node);
        }
    }
    let callable_type = checker.get_type_at_location(callee);
    let &sig = checker
        .get_signatures_of_type(callable_type, SignatureKind::Call)
        .first()?;
    function_node_from_declaration(sig.declaration()?)
}

fn detect_omitted_impure_default(
    checker: &mut Checker,
    call_node: P<Node>,
) -> Option<(&'static str, String, &'static str)> {
    let decl = resolve_callee_declaration(checker, call_node)?;
    let callee_name = react_function_name(decl)
        .or_else(|| callee_simple_name(call_node.as_call_expression().expression()))
        .unwrap_or("anonymous");
    let args = call_node.as_call_expression().arguments().nodes();
    for (index, &param) in decl.parameters().iter().enumerate() {
        let parameter = param.as_parameter_declaration();
        let Some(init) = parameter.initializer() else {
            continue;
        };
        let is_omitted = match args.get(index).copied() {
            None => true,
            Some(arg) => {
                let inner = unwrap_expression(arg);
                ast::is_identifier(inner) && inner.as_identifier().text() == "undefined"
            }
        };
        if !is_omitted {
            continue;
        }
        if let Some(impure_name) = find_impure_expression_in_tree(init) {
            let param_name = property_name_text(parameter.name())
                .map_or_else(|| format!("parameter_{index}"), str::to_owned);
            return Some((callee_name, param_name, impure_name));
        }
    }
    None
}

fn detect_impure_one_hop_body(
    checker: &mut Checker,
    call_node: P<Node>,
) -> Option<(&'static str, &'static str)> {
    let decl = resolve_callee_declaration(checker, call_node)?;
    if is_component_or_hook_function(decl)
        || ast::has_syntactic_modifier(decl, ModifierFlags::Async)
    {
        return None;
    }
    let body = decl.body()?;
    let single_expr = if body.kind() == Kind::Block {
        let stmts = body.as_block().statements().nodes();
        if stmts.len() != 1 || stmts[0].kind() != Kind::ReturnStatement {
            return None;
        }
        stmts[0].as_return_statement().expression()?
    } else {
        body
    };
    let impure_name = find_impure_expression_in_tree(single_expr)?;
    let callee_name = react_function_name(decl)
        .or_else(|| callee_simple_name(call_node.as_call_expression().expression()))
        .unwrap_or("helper");
    Some((callee_name, impure_name))
}
