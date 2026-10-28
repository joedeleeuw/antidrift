use super::syntax::{
    Binding, binding_property, const_initializer, global, object_property, owner, property,
    property_name, root_identifier, symbol, symbol_is_mutated, unwrap,
};
use antidrift_kernel::local_binding::is_identifier_reference_position;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-query-signal";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct QuerySignalOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    api_module: Option<String>,
}

#[derive(Clone, Copy)]
enum NetworkKind {
    Fetch,
    Eden,
}

pub struct RequireQuerySignal {
    scope: RuleScope,
    api_module: Option<String>,
}

pub static DEFAULT_RULE: RequireQuerySignal = RequireQuerySignal {
    scope: RuleScope::DEFAULT,
    api_module: None,
};

impl RequireQuerySignal {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = decode_rule_options::<QuerySignalOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &decoded.scope)?;
        Ok(Self {
            scope,
            api_module: decoded.api_module,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireQuerySignal {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = self.scope.in_scope(ctx);
        let functions = if enabled {
            query_functions(ctx.file.as_node())
        } else {
            FxHashSet::default()
        };
        Box::new(Visitor {
            rule: self,
            enabled,
            functions,
        })
    }
}

struct Visitor {
    rule: &'static RequireQuerySignal,
    enabled: bool,
    functions: FxHashSet<P<Node>>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled && !self.functions.is_empty() {
            LISTENERS
        } else {
            &[]
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let call = node.as_call_expression();
        let Some(kind) = network_kind(call.expression(), self.rule.api_module.as_deref()) else {
            return;
        };
        let function = owner(node);
        if !self.functions.contains(&function) {
            return;
        }
        let signal = signal_binding(function);
        let args = call.arguments().nodes();
        let threaded = signal.is_some_and(|signal| match kind {
            NetworkKind::Fetch => args
                .get(1)
                .copied()
                .filter(|arg| arg.kind() != Kind::SpreadElement)
                .and_then(|options| property(options, "signal"))
                .is_some_and(|expression| contains_signal(expression, signal)),
            NetworkKind::Eden => args
                .iter()
                .copied()
                .filter(|arg| arg.kind() != Kind::SpreadElement)
                .filter_map(|argument| property(argument, "fetch"))
                .filter_map(|fetch| property(fetch, "signal"))
                .any(|expression| contains_signal(expression, signal)),
        });
        if !threaded {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "missingQuerySignal",
                    "queryFn makes a network call without threading TanStack Query's abort signal: destructure `signal` from the queryFn argument and pass it through (`fetch(url, { signal })` or Eden's `{ fetch: { signal } }`), or a superseded call can still resolve and apply stale data after a newer one wins.",
                ),
            );
        }
    }
}

fn query_functions(root: P<Node>) -> FxHashSet<P<Node>> {
    let mut functions = FxHashSet::default();
    collect_query_functions(root, root, &mut functions);
    functions
}

fn collect_query_functions(root: P<Node>, node: P<Node>, out: &mut FxHashSet<P<Node>>) {
    if node.kind() == Kind::ObjectLiteralExpression {
        collect_object_query_functions(root, node, out);
    }
    node.for_each_child(&mut |child| {
        collect_query_functions(root, child, out);
        false
    });
}

fn collect_object_query_functions(root: P<Node>, node: P<Node>, out: &mut FxHashSet<P<Node>>) {
    let props = node.as_object_literal_expression().properties().nodes();
    let has_query_key = props.iter().any(|&prop| {
        object_property(prop).is_some_and(|(key, _, _)| property_name(key) == Some("queryKey"))
    });
    if !has_query_key {
        return;
    }
    for &prop in props {
        if let Some((key, value, _)) = object_property(prop)
            && property_name(key) == Some("queryFn")
            && let Some(func) = resolve_function(root, value, &mut FxHashSet::default())
        {
            out.insert(func);
        }
    }
}

fn resolve_function(
    root: P<Node>,
    expression: P<Node>,
    visited: &mut FxHashSet<Binding>,
) -> Option<P<Node>> {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::FunctionExpression | Kind::ArrowFunction => Some(inner),
        Kind::Identifier => {
            let binding = symbol(inner)?;
            if !visited.insert(binding) || symbol_is_mutated(root, binding) {
                return None;
            }
            if binding.decl.kind() == Kind::FunctionDeclaration {
                return Some(binding.decl);
            }
            resolve_function(root, const_initializer(binding)?, visited)
        }
        _ => None,
    }
}

fn signal_binding(function: P<Node>) -> Option<&'static str> {
    let parameter = *function.parameters().first()?;
    let pattern = parameter.name()?;
    if pattern.kind() != Kind::ObjectBindingPattern {
        return None;
    }
    for &elem in pattern.as_binding_pattern().elements().nodes() {
        if let Some(("signal", value)) = binding_property(elem)
            && ast::is_identifier(value)
        {
            return Some(value.as_identifier().text());
        }
    }
    None
}

fn network_kind(callee: P<Node>, api_module: Option<&str>) -> Option<NetworkKind> {
    if global(callee, "fetch") {
        return Some(NetworkKind::Fetch);
    }
    let inner = unwrap(callee);
    if inner.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = inner.as_property_access_expression();
    let name_node = access.name();
    if !ast::is_identifier(name_node) {
        return None;
    }
    let method = name_node.as_identifier().text();
    if method == "fetch"
        && ["globalThis", "self", "window"]
            .iter()
            .any(|host| global(access.expression(), host))
    {
        return Some(NetworkKind::Fetch);
    }
    if !["get", "post", "put", "patch", "delete", "head"].contains(&method) {
        return None;
    }
    let binding = symbol(root_identifier(access.expression())?)?;
    if binding.decl.kind() != Kind::ImportSpecifier {
        return None;
    }
    let spec = binding.decl.as_import_specifier();
    let imported = spec.property_name().or_else(|| binding.decl.name())?;
    if property_name(imported) != Some("api") {
        return None;
    }
    let mut cursor = binding.decl.parent();
    while let Some(node) = cursor {
        if node.kind() == Kind::ImportDeclaration {
            let module_spec = node.as_import_declaration().module_specifier();
            return (ast::is_string_literal(module_spec)
                && api_module == Some(module_spec.as_string_literal().text()))
            .then_some(NetworkKind::Eden);
        }
        cursor = node.parent();
    }
    None
}

fn contains_signal(expression: P<Node>, name: &str) -> bool {
    if ast::is_identifier(expression)
        && expression.as_identifier().text() == name
        && is_identifier_reference_position(expression)
    {
        return true;
    }
    let mut found = false;
    expression.for_each_child(&mut |child| {
        if contains_signal(child, name) {
            found = true;
            return true;
        }
        false
    });
    found
}
