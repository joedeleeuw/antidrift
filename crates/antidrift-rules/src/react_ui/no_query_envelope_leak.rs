use antidrift_kernel::jsx::{
    is_component_or_hook_function, is_hook_name, is_pascal_case_name, react_function_name,
};
use antidrift_kernel::local_binding::resolve_lexical_binding;
use antidrift_kernel::provenance::{
    resolve_aliased_symbol, symbol_at_node, symbol_declarations, type_symbol,
};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{
    collect_return_expressions, enclosing_function, function_node_from_declaration,
    is_function_like, is_test_file, normalize_path, property_name_text, unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, Symbol};
use tsrs_checker::{Checker, SignatureKind, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{is_type_flag_set, is_union_type};

pub const RULE_NAME: &str = "antidrift/no-query-envelope-leak";

const QUERY_ENVELOPE_TYPE_NAMES: [&str; 20] = [
    "UseQueryResult",
    "UseInfiniteQueryResult",
    "UseSuspenseQueryResult",
    "UseSuspenseInfiniteQueryResult",
    "UseMutationResult",
    "DefinedUseQueryResult",
    "DefinedUseInfiniteQueryResult",
    "UseBaseQueryResult",
    "UseBaseMutationResult",
    "QueryObserverResult",
    "InfiniteQueryObserverResult",
    "DefinedQueryObserverResult",
    "DefinedInfiniteQueryObserverResult",
    "QueryObserverBaseResult",
    "QueryObserverPendingResult",
    "QueryObserverLoadingErrorResult",
    "QueryObserverRefetchErrorResult",
    "QueryObserverSuccessResult",
    "QueryResult",
    "AsyncResult",
];

const QUERY_HOOK_CALL_NAMES: [&str; 5] = [
    "useQuery",
    "useInfiniteQuery",
    "useSuspenseQuery",
    "useSuspenseInfiniteQuery",
    "useMutation",
];

pub struct NoQueryEnvelopeLeak {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoQueryEnvelopeLeak = NoQueryEnvelopeLeak {
    scope: RuleScope::DEFAULT,
};

impl NoQueryEnvelopeLeak {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::ReturnStatement),
    Listener::Enter(Kind::ArrowFunction),
];

impl Rule for NoQueryEnvelopeLeak {
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
            Kind::ReturnStatement => inspect_return_statement(ctx, node),
            Kind::ArrowFunction => inspect_arrow_function(ctx, node),
            _ => {}
        }
    }
}

fn inspect_call_expression(ctx: &mut Ctx, call_node: P<Node>) {
    if find_enclosing_component_or_hook(call_node).is_none() {
        return;
    }
    let callee = unwrap_expression(call_node.as_call_expression().expression());
    let Some(callee_name) = extract_callee_name(callee) else {
        return;
    };
    if is_hook_name(callee_name) || is_pascal_case_name(callee_name) {
        return;
    }
    let Some(decl) = resolve_callee_function(ctx.checker, callee) else {
        return;
    };
    if let Some(sf) = ast::get_source_file_of_node(decl)
        && normalize_path(sf.file_name()).contains("/node_modules/")
    {
        return;
    }
    if !helper_returns_fresh_collection(decl) {
        return;
    }
    for &arg in call_node.as_call_expression().arguments().nodes() {
        if is_query_envelope_expression(ctx.checker, arg) {
            let arg_name = if ast::is_identifier(arg) {
                arg.as_identifier().text()
            } else {
                "query"
            };
            ctx.report_node(
                arg,
                RuleMessage::new(
                    "opaqueQueryEnvelopeArgument",
                    format!(
                        "Do not pass query envelope '{arg_name}' into local helper '{callee_name}' returning fresh collections; extract required fields or pass primitives directly."
                    ),
                ),
            );
        }
    }
}

fn inspect_return_statement(ctx: &mut Ctx, return_stmt: P<Node>) {
    let Some(expr) = return_stmt.as_return_statement().expression() else {
        return;
    };
    let Some(enclosing) = enclosing_function(return_stmt) else {
        return;
    };
    if !react_function_name(enclosing).is_some_and(is_hook_name) {
        return;
    }
    let unwrapped = unwrap_expression(expr);
    if unwrapped.kind() == Kind::ObjectLiteralExpression {
        inspect_return_object_properties(ctx, unwrapped);
    }
}

fn inspect_arrow_function(ctx: &mut Ctx, arrow_fn: P<Node>) {
    let Some(body) = arrow_fn.body() else {
        return;
    };
    if body.kind() == Kind::Block || !react_function_name(arrow_fn).is_some_and(is_hook_name) {
        return;
    }
    let unwrapped = unwrap_expression(body);
    if unwrapped.kind() == Kind::ObjectLiteralExpression {
        inspect_return_object_properties(ctx, unwrapped);
    }
}

fn inspect_return_object_properties(ctx: &mut Ctx, object_literal: P<Node>) {
    for &prop in object_literal
        .as_object_literal_expression()
        .properties()
        .nodes()
    {
        match prop.kind() {
            Kind::PropertyAssignment => {
                let assign = prop.as_property_assignment();
                if is_query_envelope_expression(ctx.checker, assign.initializer()) {
                    let prop_name = property_name_text(assign.name()).unwrap_or("query");
                    report_leaked_return_property(ctx, prop, prop_name);
                }
            }
            Kind::ShorthandPropertyAssignment => {
                let name_node = prop.as_shorthand_property_assignment().name();
                if is_query_envelope_expression(ctx.checker, name_node) {
                    let prop_name = property_name_text(name_node).unwrap_or("query");
                    report_leaked_return_property(ctx, prop, prop_name);
                }
            }
            Kind::SpreadAssignment => {
                let expr = prop.as_spread_assignment().expression();
                if is_query_envelope_expression(ctx.checker, expr) {
                    let prop_name = property_name_text(expr).unwrap_or("query");
                    report_leaked_return_property(ctx, prop, prop_name);
                }
            }
            _ => {}
        }
    }
}

fn report_leaked_return_property(ctx: &mut Ctx, prop_node: P<Node>, prop_name: &str) {
    ctx.report_node(
        prop_node,
        RuleMessage::new(
            "leakedQueryEnvelopeInReturn",
            format!(
                "Do not leak query envelope '{prop_name}' in custom hook return object; unpack required fields or expose derived state directly."
            ),
        ),
    );
}

fn extract_callee_name(callee: P<Node>) -> Option<&'static str> {
    match callee.kind() {
        Kind::Identifier => Some(callee.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            property_name_text(callee.as_property_access_expression().name())
        }
        _ => None,
    }
}

fn resolve_callee_function(checker: &mut Checker, callee: P<Node>) -> Option<P<Node>> {
    let sym = symbol_at_node(checker, callee);
    for decl in symbol_declarations(checker, sym) {
        if let Some(fn_node) = function_node_from_declaration(decl)
            && fn_node.body().is_some()
        {
            return Some(fn_node);
        }
    }
    let callable_type = checker.get_type_at_location(callee);
    let &sig = checker
        .get_signatures_of_type(callable_type, SignatureKind::Call)
        .first()?;
    let decl = sig.declaration()?;
    function_node_from_declaration(decl).filter(|fn_node| fn_node.body().is_some())
}

fn is_collection_literal(node: P<Node>) -> bool {
    let inner = unwrap_expression(node);
    match inner.kind() {
        Kind::ObjectLiteralExpression | Kind::ArrayLiteralExpression => true,
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            is_collection_literal(cond.when_true()) || is_collection_literal(cond.when_false())
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::QuestionQuestionToken | Kind::BarBarToken
            ) && (is_collection_literal(bin.left()) || is_collection_literal(bin.right()))
        }
        _ => false,
    }
}

fn helper_returns_fresh_collection(function_node: P<Node>) -> bool {
    collect_return_expressions(function_node.body())
        .into_iter()
        .any(is_collection_literal)
}

fn find_enclosing_component_or_hook(start: P<Node>) -> Option<P<Node>> {
    let mut current = start.parent();
    while let Some(node) = current {
        if is_function_like(node) && is_component_or_hook_function(node) {
            return Some(node);
        }
        current = node.parent();
    }
    None
}

fn is_query_envelope_expression(checker: &mut Checker, expr: P<Node>) -> bool {
    let typ = checker.get_type_at_location(expr);
    if is_query_envelope_type(checker, typ) {
        return true;
    }
    let inner = unwrap_expression(expr);
    if !ast::is_identifier(inner) {
        return false;
    }
    let Some(binding) = resolve_lexical_binding(inner) else {
        return false;
    };
    if binding.decl.kind() != Kind::VariableDeclaration {
        return false;
    }
    let Some(init) = binding.decl.as_variable_declaration().initializer() else {
        return false;
    };
    let unwrapped_init = unwrap_expression(init);
    if unwrapped_init.kind() != Kind::CallExpression {
        return false;
    }
    let Some(callee_name) = extract_callee_name(unwrap_expression(
        unwrapped_init.as_call_expression().expression(),
    )) else {
        return false;
    };
    QUERY_HOOK_CALL_NAMES.contains(&callee_name)
}

fn symbol_is_query_envelope(checker: &mut Checker, sym: P<Symbol>) -> bool {
    if QUERY_ENVELOPE_TYPE_NAMES.contains(&sym.name()) {
        return true;
    }
    let resolved = resolve_aliased_symbol(checker, sym);
    QUERY_ENVELOPE_TYPE_NAMES.contains(&resolved.name())
}

fn is_structural_query_envelope(checker: &mut Checker, typ: P<Type>) -> bool {
    let props = checker.get_properties_of_type(typ);
    if props.is_empty() {
        return false;
    }
    let names: FxHashSet<&str> = props.iter().map(|prop| prop.name()).collect();
    let is_query = names.contains("fetchStatus")
        && names.contains("isFetching")
        && (names.contains("refetch") || names.contains("dataUpdatedAt"));
    let is_mutation =
        names.contains("mutate") && names.contains("mutateAsync") && names.contains("reset");
    let is_async_result = names.contains("_tag")
        && names.contains("pipe")
        && (names.contains("value") || names.contains("error"));
    is_query || is_mutation || is_async_result
}

fn is_query_envelope_type(checker: &mut Checker, typ: P<Type>) -> bool {
    if is_type_flag_set(
        typ,
        TypeFlags::Any | TypeFlags::Unknown | TypeFlags::Never | TypeFlags::Void,
    ) {
        return false;
    }
    if let Some(sym) = type_symbol(typ)
        && symbol_is_query_envelope(checker, sym)
    {
        return true;
    }
    if let Some(sym) = typ.symbol()
        && symbol_is_query_envelope(checker, sym)
    {
        return true;
    }
    if is_structural_query_envelope(checker, typ) {
        return true;
    }
    if is_union_type(typ) {
        return typ
            .as_union_type()
            .types()
            .iter()
            .copied()
            .any(|member| is_query_envelope_type(checker, member));
    }
    false
}
