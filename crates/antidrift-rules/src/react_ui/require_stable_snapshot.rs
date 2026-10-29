use antidrift_kernel::imports::FileImports;
use antidrift_kernel::jsx::{
    is_hook_name, is_pascal_case_name, plain_attribute_name, react_function_name,
};
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{
    collect_return_expressions, is_function_like, property_name_text, unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-stable-snapshot";
const HOOK_NAME: &str = "useSyncExternalStore";
const SNAPSHOT_ARGUMENT_INDICES: [usize; 2] = [1, 2];
const FRESH_STATIC_CALLS: [(&str, &str); 7] = [
    ("Object", "assign"),
    ("Object", "values"),
    ("Object", "keys"),
    ("Object", "entries"),
    ("Object", "fromEntries"),
    ("Array", "from"),
    ("Array", "of"),
];
const FRESH_MEMBER_METHODS: [&str; 6] = ["map", "filter", "slice", "concat", "flat", "flatMap"];
const COMPARATOR_OPTION_NAMES: [&str; 6] = [
    "structuralSharing",
    "equalityFn",
    "compare",
    "isEqual",
    "shallow",
    "selectCompare",
];
const EXEMPT_LAZY_HOOKS: [&str; 6] = [
    "useState",
    "useMemo",
    "useCallback",
    "useEffect",
    "useLayoutEffect",
    "useInsertionEffect",
];
const MESSAGE: &str = "getSnapshot/getServerSnapshot must return a cached reference, not a fresh object/array/derived collection each call. React compares results with Object.is, so an unstable snapshot trips 'The result of getSnapshot should be cached' and can loop into 'Maximum update depth exceeded'. Cache the snapshot in the store and return the same reference until the underlying data changes.";

pub struct RequireStableSnapshot {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireStableSnapshot = RequireStableSnapshot {
    scope: RuleScope::DEFAULT,
};

impl RequireStableSnapshot {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::NewExpression),
];

impl Rule for RequireStableSnapshot {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(Visitor {
                active: false,
                aliases: FxHashSet::default(),
                namespaces: FxHashSet::default(),
            });
        }
        let imports = FileImports::collect(ctx.file);
        Box::new(Visitor {
            active: true,
            aliases: imports.locals_from("react", &[HOOK_NAME]),
            namespaces: imports.namespaces_from("react"),
        })
    }
}

struct Visitor {
    active: bool,
    aliases: FxHashSet<&'static str>,
    namespaces: FxHashSet<&'static str>,
}

impl Visitor {
    fn is_sync_external_store_call(&self, call_node: P<Node>) -> bool {
        let callee = unwrap_expression(call_node.as_call_expression().expression());
        match callee.kind() {
            Kind::Identifier => {
                let text = callee.as_identifier().text();
                text == HOOK_NAME || self.aliases.contains(text)
            }
            Kind::PropertyAccessExpression => {
                let access = callee.as_property_access_expression();
                let prop = access.name();
                let obj = unwrap_expression(access.expression());
                ast::is_identifier(prop)
                    && prop.as_identifier().text() == HOOK_NAME
                    && ast::is_identifier(obj)
                    && (obj.as_identifier().text() == "React"
                        || self.namespaces.contains(obj.as_identifier().text()))
            }
            _ => false,
        }
    }
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.active { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() == Kind::NewExpression {
            if let Some(primitive) = reactive_primitive_name(node)
                && is_inside_render_body(node)
            {
                report_reactive_primitive(ctx, node, primitive);
            }
            return;
        }
        if self.is_sync_external_store_call(node) {
            let args = node.as_call_expression().arguments().nodes();
            let unstable = SNAPSHOT_ARGUMENT_INDICES
                .iter()
                .filter_map(|&index| args.get(index).copied())
                .any(|arg| {
                    resolve_snapshot_function(arg, &mut FxHashSet::default())
                        .is_some_and(snapshot_returns_fresh_reference)
                });
            if unstable {
                ctx.report_node(node, RuleMessage::new("requireStableSnapshot", MESSAGE));
                return;
            }
        }
        check_selector_hook(ctx, node);
        if let Some(primitive) = reactive_primitive_name(node)
            && is_inside_render_body(node)
        {
            report_reactive_primitive(ctx, node, primitive);
        }
    }
}

fn report_reactive_primitive(ctx: &mut Ctx, node: P<Node>, primitive: &str) {
    ctx.report_node(
        node,
        RuleMessage::new(
            "reactivePrimitiveInRender",
            format!(
                "Reactive primitive '{primitive}' instantiated directly in component/hook render body. This allocates a fresh instance on every render, resetting state and subscriptions. Move to module scope or initialize lazily via useState(() => ...)."
            ),
        ),
    );
}

fn check_selector_hook(ctx: &mut Ctx, call_node: P<Node>) {
    let Some(hook_name) = callee_hook_name(call_node.as_call_expression().expression()) else {
        return;
    };
    let Some((selector_node, has_comparator)) = extract_selector_argument(call_node, hook_name)
    else {
        return;
    };
    if has_comparator {
        return;
    }
    let Some(snapshot_fn) = resolve_snapshot_function(selector_node, &mut FxHashSet::default())
    else {
        return;
    };
    if snapshot_returns_fresh_reference(snapshot_fn) {
        ctx.report_node(
            call_node,
            RuleMessage::new(
                "requireStableSnapshotSelector",
                format!(
                    "Selector passed to '{hook_name}' returns a fresh object/array/derived collection without an equality comparator. React re-renders on every update because Object.is comparison fails. Pass an equality comparator (e.g. shallow or shallowEqual) or cache the selector result."
                ),
            ),
        );
    }
}

fn callee_hook_name(callee: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(callee);
    let name = match inner.kind() {
        Kind::Identifier => Some(inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            property_name_text(inner.as_property_access_expression().name())
        }
        _ => None,
    }?;
    is_hook_name(name).then_some(name)
}

fn find_object_property(object_literal: P<Node>, target_key: &str) -> Option<P<Node>> {
    if object_literal.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    for &prop in object_literal
        .as_object_literal_expression()
        .properties()
        .nodes()
    {
        if prop.kind() == Kind::PropertyAssignment {
            let assign = prop.as_property_assignment();
            if property_name_text(assign.name()) == Some(target_key) {
                return Some(assign.initializer());
            }
        } else if prop.kind() == Kind::MethodDeclaration
            && property_name_text(prop.as_method_declaration().name()) == Some(target_key)
        {
            return Some(prop);
        }
    }
    None
}

fn has_comparator_property(object_literal: P<Node>) -> bool {
    if object_literal.kind() != Kind::ObjectLiteralExpression {
        return false;
    }
    for &prop in object_literal
        .as_object_literal_expression()
        .properties()
        .nodes()
    {
        let Some(name) = prop.name().and_then(property_name_text) else {
            continue;
        };
        if !COMPARATOR_OPTION_NAMES.contains(&name) {
            continue;
        }
        if name == "structuralSharing"
            && prop.kind() == Kind::PropertyAssignment
            && unwrap_expression(prop.as_property_assignment().initializer()).kind()
                == Kind::FalseKeyword
        {
            continue;
        }
        return true;
    }
    false
}

fn extract_selector_argument(call_node: P<Node>, hook_name: &str) -> Option<(P<Node>, bool)> {
    let args = call_node.as_call_expression().arguments().nodes();
    match hook_name {
        "useParams" | "useSearch" => {
            let options = unwrap_expression(*args.first()?);
            let selector = find_object_property(options, "select")?;
            let has_comp = has_comparator_property(options) || args.len() >= 2;
            Some((selector, has_comp))
        }
        "useSelector" => Some((*args.first()?, args.len() >= 2)),
        "useStore" => Some((*args.get(1)?, args.len() >= 3)),
        "useAtomValue" => {
            let second = unwrap_expression(*args.get(1)?);
            if second.kind() == Kind::ObjectLiteralExpression {
                let selector = find_object_property(second, "select")?;
                Some((selector, has_comparator_property(second)))
            } else {
                Some((second, args.len() >= 3))
            }
        }
        _ => None,
    }
}

fn resolve_snapshot_function(node: P<Node>, seen: &mut FxHashSet<Binding>) -> Option<P<Node>> {
    let inner = unwrap_expression(node);
    if matches!(
        inner.kind(),
        Kind::ArrowFunction
            | Kind::FunctionExpression
            | Kind::FunctionDeclaration
            | Kind::MethodDeclaration
    ) {
        return Some(inner);
    }
    if ast::is_identifier(inner) {
        let binding = resolve_lexical_binding(inner)?;
        if !seen.insert(binding) {
            return None;
        }
        return match binding.decl.kind() {
            Kind::FunctionDeclaration => Some(binding.decl),
            Kind::VariableDeclaration => {
                let init = binding.decl.as_variable_declaration().initializer()?;
                resolve_snapshot_function(init, seen)
            }
            _ => None,
        };
    }
    if inner.kind() == Kind::PropertyAccessExpression {
        let access = inner.as_property_access_expression();
        let target_prop = property_name_text(access.name())?;
        let obj = unwrap_expression(access.expression());
        if !ast::is_identifier(obj) {
            return None;
        }
        let binding = resolve_lexical_binding(obj)?;
        if !seen.insert(binding) || binding.decl.kind() != Kind::VariableDeclaration {
            return None;
        }
        let init = unwrap_expression(binding.decl.as_variable_declaration().initializer()?);
        let prop_val = find_object_property(init, target_prop)?;
        return resolve_snapshot_function(prop_val, seen);
    }
    None
}

fn is_fresh_reference_call(call_node: P<Node>) -> bool {
    let callee = unwrap_expression(call_node.as_call_expression().expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = callee.as_property_access_expression();
    let Some(method) = property_name_text(access.name()) else {
        return false;
    };
    let obj = unwrap_expression(access.expression());
    let is_static_fresh = ast::is_identifier(obj)
        && FRESH_STATIC_CALLS
            .iter()
            .any(|(owner, name)| obj.as_identifier().text() == *owner && method == *name);
    is_static_fresh || FRESH_MEMBER_METHODS.contains(&method)
}

fn is_fresh_reference(expression: P<Node>) -> bool {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::ObjectLiteralExpression | Kind::ArrayLiteralExpression => true,
        Kind::CallExpression => is_fresh_reference_call(inner),
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            is_fresh_reference(cond.when_true()) || is_fresh_reference(cond.when_false())
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) && (is_fresh_reference(bin.left()) || is_fresh_reference(bin.right()))
        }
        _ => false,
    }
}

fn snapshot_returns_fresh_reference(function_node: P<Node>) -> bool {
    collect_return_expressions(function_node.body())
        .into_iter()
        .any(is_fresh_reference)
}

fn reactive_primitive_name(node: P<Node>) -> Option<&'static str> {
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

fn is_inside_render_body(node: P<Node>) -> bool {
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
