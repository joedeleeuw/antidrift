use super::await_waterfall::{independent_await_runs, relational_key_join_calls};
use antidrift_kernel::jsx::{
    function_returns_jsx, is_component_or_hook_function, react_function_name,
};
use antidrift_kernel::local_binding::{
    Binding, binding_pattern_identifiers, for_each_resolved_reference, resolve_lexical_binding,
};
use antidrift_kernel::relational_scan::{is_inner_linear_scan_method, is_outer_traversal_method};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::tsrs_kernel::{
    callee_name, is_function_like, numeric_literal_value, property_name_text, unwrap_expression,
};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-query-join-or-tree-reshape";

const REACTIVE_SOURCE_HOOKS: [&str; 7] = [
    "useQuery",
    "useSuspenseQuery",
    "useInfiniteQuery",
    "usePaginatedQuery",
    "useSyncExternalStore",
    "useAtomValue",
    "useStore",
];
const NESTED_PROJECTION_METHODS: [&str; 2] = ["flatMap", "map"];
const FLATTEN_DEPTH: f64 = 2.0;

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
];

pub struct NoQueryJoinOrTreeReshape {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoQueryJoinOrTreeReshape = NoQueryJoinOrTreeReshape {
    scope: RuleScope::DEFAULT,
};

impl NoQueryJoinOrTreeReshape {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

impl Rule for NoQueryJoinOrTreeReshape {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.admits_authored_source(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

#[derive(Clone, Copy)]
enum Finding {
    MultiQueryRenderJoin,
    RenderTreeFlattenReshape,
    SequentialAsyncWaterfall,
}

impl Finding {
    fn message(self) -> RuleMessage {
        match self {
            Self::MultiQueryRenderJoin => RuleMessage::new(
                "multiQueryRenderJoin",
                "Two or more reactive query/store collections are joined during render; move the join to the query select, store selector, or producer so render receives one typed projection.",
            ),
            Self::RenderTreeFlattenReshape => RuleMessage::new(
                "renderTreeFlattenReshape",
                "A nested query/prop tree is flattened two levels deep during render; move the tree-to-row projection to the query select, store, or producer boundary.",
            ),
            Self::SequentialAsyncWaterfall => RuleMessage::new(
                "sequentialAsyncWaterfall",
                "Three or more independent reads are awaited one after another; batch them with Promise.all([...]) so they run concurrently.",
            ),
        }
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(body) = node.body() else {
            return;
        };
        let mut findings = Vec::new();
        if node.modifier_flags().contains(ModifierFlags::Async) {
            findings.extend(
                independent_await_runs(body)
                    .into_iter()
                    .map(|statement| (statement, Finding::SequentialAsyncWaterfall)),
            );
        }
        if is_render_function(node) {
            RenderScan::run(node, body, &mut findings);
        }
        for call in relational_key_join_calls(body) {
            if !findings.iter().any(|(existing, _)| *existing == call) {
                findings.push((call, Finding::MultiQueryRenderJoin));
            }
        }
        for (reported, finding) in findings {
            ctx.report_node(reported, finding.message());
        }
    }
}

fn is_render_function(function: P<Node>) -> bool {
    if !is_component_or_hook_function(function) {
        return false;
    }
    react_function_name(function).is_some()
        || !function.parent().is_some_and(|parent| {
            matches!(parent.kind(), Kind::CallExpression | Kind::JsxExpression)
        })
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Source {
    origin: P<Node>,
    reactive: bool,
}

type Sources = FxHashSet<Source>;

struct RenderScan<'a> {
    sources: FxHashMap<Binding, Sources>,
    findings: &'a mut Vec<(P<Node>, Finding)>,
}

impl RenderScan<'_> {
    fn run(function: P<Node>, body: P<Node>, findings: &mut Vec<(P<Node>, Finding)>) {
        let mut scan = RenderScan {
            sources: FxHashMap::default(),
            findings,
        };
        for &parameter in function.parameters() {
            let prop = Source {
                origin: parameter,
                reactive: false,
            };
            scan.bind(parameter, &std::iter::once(prop).collect());
        }
        scan.walk(body);
    }

    fn bind(&mut self, declaration: P<Node>, sources: &Sources) {
        let Some(name) = declaration.name() else {
            return;
        };
        for ident in binding_pattern_identifiers(name) {
            self.sources.insert(
                Binding {
                    decl: declaration,
                    ident,
                },
                sources.clone(),
            );
        }
    }

    fn walk(&mut self, node: P<Node>) {
        match node.kind() {
            Kind::VariableDeclaration => self.record(node),
            Kind::ArrayLiteralExpression => self.check_spread_join(node),
            Kind::CallExpression => self.check_call(node),
            _ => {}
        }
        node.for_each_child(&mut |child| {
            if !is_function_like(child) {
                self.walk(child);
            }
            false
        });
    }

    fn record(&mut self, declaration: P<Node>) {
        let Some(initializer) = declaration.as_variable_declaration().initializer() else {
            return;
        };
        if is_reactive_source_call(initializer) {
            let reactive = Source {
                origin: declaration,
                reactive: true,
            };
            self.bind(declaration, &std::iter::once(reactive).collect());
            return;
        }
        let derived = self.sources_of(initializer);
        if !derived.is_empty() {
            self.bind(declaration, &derived);
        }
    }

    fn sources_of(&self, node: P<Node>) -> Sources {
        let mut sources = Sources::default();
        for_each_resolved_reference(node, false, &mut |binding| {
            if let Some(bound) = self.sources.get(&binding) {
                sources.extend(bound);
            }
        });
        sources
    }

    fn reactive_sources_of(&self, node: P<Node>) -> Sources {
        self.sources_of(node)
            .into_iter()
            .filter(|source| source.reactive)
            .collect()
    }

    fn check_spread_join(&mut self, array: P<Node>) {
        let operands: Vec<Sources> = array
            .as_array_literal_expression()
            .elements()
            .nodes()
            .iter()
            .filter(|element| element.kind() == Kind::SpreadElement)
            .map(|element| self.reactive_sources_of(element.as_spread_element().expression()))
            .collect();
        if joins_distinct_sources(&operands) {
            self.findings.push((array, Finding::MultiQueryRenderJoin));
        }
    }

    fn check_call(&mut self, call: P<Node>) {
        let Some((receiver, method)) = method_call(call) else {
            return;
        };
        let arguments = call.as_call_expression().arguments().nodes();
        if method == "concat" {
            let mut operands = vec![self.reactive_sources_of(receiver)];
            operands.extend(arguments.iter().map(|&arg| self.reactive_sources_of(arg)));
            if joins_distinct_sources(&operands) {
                self.findings.push((call, Finding::MultiQueryRenderJoin));
            }
            return;
        }
        let callback = arguments
            .first()
            .copied()
            .filter(|&arg| is_function_like(arg));
        if is_outer_traversal_method(method)
            && let Some(callback) = callback
            && self.is_nested_lookup_join(receiver, callback)
        {
            self.findings.push((call, Finding::MultiQueryRenderJoin));
        }
        if self.is_tree_flatten(call, receiver, method, callback) {
            self.findings
                .push((call, Finding::RenderTreeFlattenReshape));
        }
    }

    fn is_nested_lookup_join(&self, receiver: P<Node>, callback: P<Node>) -> bool {
        let outer = self.reactive_sources_of(receiver);
        if outer.is_empty() || function_returns_jsx(callback) {
            return false;
        }
        let Some(body) = callback.body() else {
            return false;
        };
        any_descendant(body, true, &mut |node| {
            method_call(node).is_some_and(|(inner_receiver, inner_method)| {
                is_inner_linear_scan_method(inner_method)
                    && self
                        .reactive_sources_of(inner_receiver)
                        .iter()
                        .any(|source| !outer.contains(source))
            })
        })
    }

    fn is_tree_flatten(
        &self,
        call: P<Node>,
        receiver: P<Node>,
        method: &str,
        callback: Option<P<Node>>,
    ) -> bool {
        let structural = match method {
            "flat" => has_deep_flatten_depth(call),
            "flatMap" => {
                (is_method_call(receiver, "flatMap") && !is_chained_into_flat_map(call))
                    || callback.is_some_and(projects_nested_parameter_collection)
            }
            _ => false,
        };
        structural && !self.sources_of(receiver).is_empty()
    }
}

fn joins_distinct_sources(operands: &[Sources]) -> bool {
    let contributing = operands.iter().filter(|sources| !sources.is_empty());
    let union: Sources = contributing.clone().flatten().copied().collect();
    contributing.count() >= 2 && union.len() >= 2
}

fn is_reactive_source_call(initializer: P<Node>) -> bool {
    let mut expression = unwrap_expression(initializer);
    if ast::is_binary_expression(expression)
        && matches!(
            expression.as_binary_expression().operator_token().kind(),
            Kind::QuestionQuestionToken | Kind::BarBarToken
        )
    {
        expression = unwrap_expression(expression.as_binary_expression().left());
    }
    if expression.kind() == Kind::PropertyAccessExpression
        && property_name_text(expression.as_property_access_expression().name()) == Some("data")
    {
        expression = unwrap_expression(expression.as_property_access_expression().expression());
    }
    if expression.kind() != Kind::CallExpression {
        return false;
    }
    callee_name(expression).is_some_and(|name| REACTIVE_SOURCE_HOOKS.contains(&name))
}

fn method_call(node: P<Node>) -> Option<(P<Node>, &'static str)> {
    if node.kind() != Kind::CallExpression {
        return None;
    }
    let callee = unwrap_expression(node.as_call_expression().expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = callee.as_property_access_expression();
    Some((access.expression(), property_name_text(access.name())?))
}

fn is_method_call(node: P<Node>, method: &str) -> bool {
    method_call(unwrap_expression(node)).is_some_and(|(_, name)| name == method)
}

fn is_chained_into_flat_map(call: P<Node>) -> bool {
    let Some(access) = call.parent() else {
        return false;
    };
    access.kind() == Kind::PropertyAccessExpression
        && access.as_property_access_expression().expression() == call
        && property_name_text(access.as_property_access_expression().name()) == Some("flatMap")
        && access
            .parent()
            .is_some_and(|outer| is_method_call(outer, "flatMap"))
}

fn has_deep_flatten_depth(call: P<Node>) -> bool {
    let Some(&depth) = call.as_call_expression().arguments().nodes().first() else {
        return false;
    };
    let depth = unwrap_expression(depth);
    numeric_literal_value(depth).is_some_and(|value| value >= FLATTEN_DEPTH)
        || (ast::is_identifier(depth) && depth.as_identifier().text() == "Infinity")
}

fn projects_nested_parameter_collection(callback: P<Node>) -> bool {
    let Some(&parameter) = callback.parameters().first() else {
        return false;
    };
    let Some(body) = callback.body() else {
        return false;
    };
    any_descendant(body, false, &mut |node| {
        method_call(node).is_some_and(|(receiver, method)| {
            NESTED_PROJECTION_METHODS.contains(&method) && is_parameter_member(receiver, parameter)
        })
    })
}

fn is_parameter_member(receiver: P<Node>, parameter: P<Node>) -> bool {
    let mut base = unwrap_expression(receiver);
    let mut hops = 0usize;
    loop {
        let object = match base.kind() {
            Kind::PropertyAccessExpression => base.as_property_access_expression().expression(),
            Kind::ElementAccessExpression => base.as_element_access_expression().expression(),
            _ => break,
        };
        base = unwrap_expression(object);
        hops += 1;
    }
    let Some(binding) = resolve_lexical_binding(base) else {
        return false;
    };
    if binding.decl == parameter {
        return hops > 0;
    }
    binding.decl.kind() == Kind::BindingElement && is_within(binding.decl, parameter)
}

fn is_within(node: P<Node>, ancestor: P<Node>) -> bool {
    let mut cursor = node.parent();
    while let Some(current) = cursor {
        if current == ancestor {
            return true;
        }
        if is_function_like(current) {
            return false;
        }
        cursor = current.parent();
    }
    false
}

fn any_descendant(
    node: P<Node>,
    enter_functions: bool,
    predicate: &mut dyn FnMut(P<Node>) -> bool,
) -> bool {
    if predicate(node) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        found = (enter_functions || !is_function_like(child))
            && any_descendant(child, enter_functions, predicate);
        found
    });
    found
}
