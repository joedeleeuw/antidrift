use antidrift_kernel::jsx::{
    is_event_handler_name, is_hook_name, is_pascal_case_name, react_function_name,
};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{is_function_like, property_name_text, unwrap_expression};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unstable-render-default-collection";

const COLLECTION_CONSTRUCTORS: &[&str] = &["Map", "Set", "WeakMap", "WeakSet", "Array", "Object"];

const TIMER_OR_EVENT_METHODS: &[&str] = &[
    "addEventListener",
    "removeEventListener",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "queueMicrotask",
    "then",
    "catch",
    "finally",
];

pub struct NoUnstableRenderDefaultCollection {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoUnstableRenderDefaultCollection = NoUnstableRenderDefaultCollection {
    scope: RuleScope::DEFAULT,
};

impl NoUnstableRenderDefaultCollection {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::BinaryExpression),
];

impl Rule for NoUnstableRenderDefaultCollection {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            active: in_scope(&self.scope, ctx, None),
        })
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
        if is_function_like(node) && is_named_component_or_hook(node) {
            for &param in node.parameters() {
                check_parameter_defaults(ctx, param);
            }
            return;
        }
        if node.kind() == Kind::BinaryExpression {
            let bin = node.as_binary_expression();
            if matches!(
                bin.operator_token().kind(),
                Kind::QuestionQuestionToken | Kind::BarBarToken
            ) && is_collection_allocation(bin.right())
                && is_inside_render_body(node)
            {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "unstableRenderFallbackCollection",
                        "Inline fallback collection allocates a fresh reference every render, busting React Compiler and downstream memoization. Hoist an immutable constant (e.g. const EMPTY = []) and default to it (e.g. expr ?? EMPTY).",
                    ),
                );
            }
        }
    }
}

fn check_parameter_defaults(ctx: &mut Ctx, param: P<Node>) {
    let parameter = param.as_parameter_declaration();
    if let Some(init) = parameter.initializer()
        && is_collection_allocation(init)
    {
        report_default_collection(ctx, param);
    }
    check_binding_pattern_defaults(ctx, parameter.name());
}

fn check_binding_pattern_defaults(ctx: &mut Ctx, pattern: P<Node>) {
    if !matches!(
        pattern.kind(),
        Kind::ObjectBindingPattern | Kind::ArrayBindingPattern
    ) {
        return;
    }
    for &elem in pattern.as_binding_pattern().elements().nodes() {
        if elem.kind() != Kind::BindingElement {
            continue;
        }
        let binding_elem = elem.as_binding_element();
        if let Some(init) = binding_elem.initializer()
            && is_collection_allocation(init)
        {
            report_default_collection(ctx, elem);
        }
        if let Some(inner_name) = binding_elem.name() {
            check_binding_pattern_defaults(ctx, inner_name);
        }
    }
}

fn report_default_collection(ctx: &mut Ctx, target_node: P<Node>) {
    ctx.report_node(
        target_node,
        RuleMessage::new(
            "unstableRenderDefaultCollection",
            "Default parameter collection allocates a fresh reference every render when omitted, busting React Compiler and downstream memoization. Hoist an immutable constant (e.g. const EMPTY = []) or default to a hoisted constant.",
        ),
    );
}

fn is_collection_allocation(node: P<Node>) -> bool {
    let unwrapped = unwrap_expression(node);
    match unwrapped.kind() {
        Kind::ArrayLiteralExpression | Kind::ObjectLiteralExpression => true,
        Kind::NewExpression => {
            let callee = unwrap_expression(unwrapped.as_new_expression().expression());
            ast::is_identifier(callee)
                && COLLECTION_CONSTRUCTORS.contains(&callee.as_identifier().text())
        }
        Kind::CallExpression => {
            let callee = unwrap_expression(unwrapped.as_call_expression().expression());
            if callee.kind() != Kind::PropertyAccessExpression {
                return false;
            }
            let access = callee.as_property_access_expression();
            ast::is_identifier(access.expression())
                && access.expression().as_identifier().text() == "Object"
                && property_name_text(access.name()) == Some("create")
        }
        _ => false,
    }
}

fn is_class_member(node: P<Node>) -> bool {
    let mut current = node.parent();
    while let Some(curr) = current {
        if matches!(
            curr.kind(),
            Kind::MethodDeclaration
                | Kind::PropertyDeclaration
                | Kind::ClassDeclaration
                | Kind::ClassExpression
        ) {
            return true;
        }
        if matches!(
            curr.kind(),
            Kind::FunctionDeclaration | Kind::FunctionExpression | Kind::ArrowFunction
        ) {
            break;
        }
        current = curr.parent();
    }
    false
}

fn is_named_component_or_hook(node: P<Node>) -> bool {
    !is_class_member(node)
        && react_function_name(node)
            .is_some_and(|name| is_pascal_case_name(name) || is_hook_name(name))
}

fn is_inside_render_body(node: P<Node>) -> bool {
    let mut current = node.parent();
    while let Some(curr) = current {
        if matches!(
            curr.kind(),
            Kind::FunctionDeclaration | Kind::FunctionExpression | Kind::ArrowFunction
        ) {
            if is_exempted_function(curr) {
                return false;
            }
            if is_named_component_or_hook(curr) {
                return true;
            }
        }
        current = curr.parent();
    }
    false
}

fn is_exempted_function(candidate: P<Node>) -> bool {
    if candidate.modifier_flags().contains(ModifierFlags::Async) {
        return true;
    }
    is_exempt_hook_callback(candidate)
        || is_timer_or_async_callback(candidate)
        || is_event_handler_callback(candidate)
}

fn callee_hook_name(callee: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(callee);
    match inner.kind() {
        Kind::Identifier => Some(inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            (ast::is_identifier(access.expression())
                && access.expression().as_identifier().text() == "React")
                .then(|| property_name_text(access.name()))
                .flatten()
        }
        _ => None,
    }
}

fn is_exempt_hook_callback(candidate: P<Node>) -> bool {
    let Some(parent) = candidate.parent() else {
        return false;
    };
    if parent.kind() != Kind::CallExpression {
        return false;
    }
    let call = parent.as_call_expression();
    let Some(hook_name) = callee_hook_name(call.expression()) else {
        return false;
    };
    let args = call.arguments().nodes();
    if matches!(
        hook_name,
        "useEffect"
            | "useLayoutEffect"
            | "useInsertionEffect"
            | "useCallback"
            | "useMemo"
            | "useState"
    ) {
        return args
            .first()
            .is_some_and(|&arg| unwrap_expression(arg) == candidate);
    }
    if hook_name == "useReducer" {
        return args
            .get(2)
            .is_some_and(|&arg| unwrap_expression(arg) == candidate);
    }
    false
}

fn is_timer_or_async_callback(candidate: P<Node>) -> bool {
    let Some(parent) = candidate.parent() else {
        return false;
    };
    if parent.kind() != Kind::CallExpression {
        return false;
    }
    let callee = unwrap_expression(parent.as_call_expression().expression());
    match callee.kind() {
        Kind::Identifier => TIMER_OR_EVENT_METHODS.contains(&callee.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            property_name_text(callee.as_property_access_expression().name())
                .is_some_and(|name| TIMER_OR_EVENT_METHODS.contains(&name))
        }
        _ => false,
    }
}

fn is_event_handler_callback(candidate: P<Node>) -> bool {
    if let Some(name) = candidate.name().and_then(property_name_text)
        && is_event_handler_name(name)
    {
        return true;
    }
    let Some(parent) = candidate.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::JsxExpression => parent
            .parent()
            .filter(|&p| p.kind() == Kind::JsxAttribute)
            .and_then(|attr| property_name_text(attr.as_jsx_attribute().name()))
            .is_some_and(is_event_handler_name),
        Kind::VariableDeclaration => {
            let name_node = parent.as_variable_declaration().name();
            ast::is_identifier(name_node) && is_event_handler_name(name_node.as_identifier().text())
        }
        Kind::PropertyAssignment => property_name_text(parent.as_property_assignment().name())
            .is_some_and(is_event_handler_name),
        Kind::BinaryExpression => {
            let bin = parent.as_binary_expression();
            bin.operator_token().kind() == Kind::EqualsToken
                && ast::is_identifier(bin.left())
                && is_event_handler_name(bin.left().as_identifier().text())
        }
        _ => false,
    }
}
