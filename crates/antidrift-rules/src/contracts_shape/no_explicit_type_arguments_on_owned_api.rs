use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{boundary, provenance, tsrs_kernel};
use tsrs_ast::{Kind, Node};
use tsrs_checker::{Checker, SignatureKind, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-explicit-type-arguments-on-owned-api";

pub struct NoExplicitTypeArgumentsOnOwnedApi {
    scope: RuleScope,
}

pub static RULE: NoExplicitTypeArgumentsOnOwnedApi = NoExplicitTypeArgumentsOnOwnedApi {
    scope: RuleScope::DEFAULT,
};

impl NoExplicitTypeArgumentsOnOwnedApi {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

fn build_explicit_type_arguments_on_owned_api_message() -> RuleMessage {
    RuleMessage::new(
        "explicitTypeArgumentsOnOwnedApi",
        "Do not pass explicit type arguments when the callee or registration object already owns the contract.",
    )
}

fn root_identifier(node: P<Node>) -> Option<P<Node>> {
    let mut current = tsrs_kernel::unwrap_expression(node);
    while current.kind() == Kind::PropertyAccessExpression {
        current =
            tsrs_kernel::unwrap_expression(current.as_property_access_expression().expression());
    }
    (current.kind() == Kind::Identifier).then_some(current)
}

fn find_enclosing_import_declaration(node: P<Node>) -> Option<P<Node>> {
    let mut current = Some(node);
    while let Some(candidate) = current {
        if candidate.kind() == Kind::ImportDeclaration {
            return Some(candidate);
        }
        current = candidate.parent();
    }
    None
}

fn is_convex_generated_api_import_decl(decl: P<Node>) -> bool {
    if !matches!(
        decl.kind(),
        Kind::ImportSpecifier | Kind::ImportClause | Kind::NamespaceImport
    ) {
        return false;
    }
    let Some(import_decl) = find_enclosing_import_declaration(decl) else {
        return false;
    };
    let specifier = import_decl.as_import_declaration().module_specifier();
    specifier.kind() == Kind::StringLiteral
        && specifier
            .as_string_literal()
            .text()
            .ends_with("convex/_generated/api")
}

fn is_imported_from_convex_generated_api(checker: &mut Checker, ident_node: P<Node>) -> bool {
    let Some(symbol) = provenance::symbol_at_node(checker, ident_node) else {
        return false;
    };
    symbol
        .declarations()
        .iter()
        .copied()
        .any(is_convex_generated_api_import_decl)
}

fn is_convex_hook_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    if callee.kind() != Kind::Identifier {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(checker, callee) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    if !matches!(
        resolved.name(),
        "useQuery" | "useMutation" | "useAction" | "usePaginatedQuery"
    ) {
        return false;
    }
    let Some(pkg) = boundary::symbol_package_path(checker, Some(symbol)) else {
        return false;
    };
    if !((pkg == "convex" || pkg.starts_with("convex/")) && pkg.contains("/react")) {
        return false;
    }
    let Some(&arg0) = call.arguments().nodes().first() else {
        return false;
    };
    let Some(root_ident) = root_identifier(arg0) else {
        return false;
    };
    is_imported_from_convex_generated_api(checker, root_ident)
}

fn is_trpc_procedure_hook_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    let callee = call_node.as_call_expression().expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let name_node = callee.as_property_access_expression().name();
    if name_node.kind() != Kind::Identifier {
        return false;
    }
    if !matches!(
        name_node.as_identifier().text(),
        "useQuery" | "useMutation" | "useSuspenseQuery" | "useInfiniteQuery"
    ) {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(checker, name_node) else {
        return false;
    };
    boundary::symbol_package_path(checker, Some(symbol))
        .is_some_and(|pkg| pkg.starts_with("@trpc/"))
}

fn is_concrete_return_type(checker: &mut Checker, return_type: P<Type>) -> bool {
    let unowned_flags = TypeFlags::Any | TypeFlags::Unknown | TypeFlags::Never;
    if return_type.flags().intersects(unowned_flags) {
        return false;
    }
    let awaited = checker
        .get_awaited_type_exported(return_type)
        .unwrap_or(return_type);
    !awaited.flags().intersects(unowned_flags)
}

fn is_swr_owned_fetcher_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    if callee.kind() != Kind::Identifier {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(checker, callee) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    let name = if resolved.name().is_empty() {
        callee.as_identifier().text()
    } else {
        resolved.name()
    };
    if !matches!(
        name,
        "useSWR" | "useSWRImmutable" | "useSWRInfinite" | "useSWRMutation"
    ) {
        return false;
    }
    let Some(pkg) = boundary::symbol_package_path(checker, Some(symbol)) else {
        return false;
    };
    if !(pkg == "swr" || pkg.starts_with("swr/")) {
        return false;
    }
    let Some(&fetcher_arg) = call.arguments().nodes().get(1) else {
        return false;
    };
    let fetcher = tsrs_kernel::unwrap_expression(fetcher_arg);
    if !matches!(
        fetcher.kind(),
        Kind::Identifier | Kind::PropertyAccessExpression
    ) {
        return false;
    }
    let fetcher_type = checker.get_type_at_location(fetcher);
    let signatures = checker.get_signatures_of_type(fetcher_type, SignatureKind::Call);
    !signatures.is_empty()
        && signatures.iter().copied().all(|sig| {
            let return_type = checker.get_return_type_of_signature(sig);
            is_concrete_return_type(checker, return_type)
        })
}

fn is_tanstack_identifier_callee(checker: &mut Checker, callee: P<Node>) -> bool {
    let Some(symbol) = provenance::symbol_at_node(checker, callee) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    matches!(
        resolved.name(),
        "useQuery" | "useMutation" | "useSuspenseQuery" | "useInfiniteQuery"
    ) && boundary::symbol_package_path(checker, Some(symbol))
        .is_some_and(|pkg| pkg.starts_with("@tanstack/react-query"))
}

fn is_tanstack_property_callee(checker: &mut Checker, callee: P<Node>) -> bool {
    let name_node = callee.as_property_access_expression().name();
    if name_node.kind() != Kind::Identifier
        || !matches!(
            name_node.as_identifier().text(),
            "getQueryData" | "setQueryData" | "fetchQuery" | "prefetchQuery" | "ensureQueryData"
        )
    {
        return false;
    }
    let Some(symbol) = provenance::symbol_at_node(checker, name_node) else {
        return false;
    };
    boundary::symbol_package_path(checker, Some(symbol)).is_some_and(|pkg| {
        pkg.starts_with("@tanstack/react-query") || pkg.starts_with("@tanstack/query-core")
    })
}

fn is_tanstack_callee(checker: &mut Checker, callee: P<Node>) -> bool {
    match callee.kind() {
        Kind::Identifier => is_tanstack_identifier_callee(checker, callee),
        Kind::PropertyAccessExpression => is_tanstack_property_callee(checker, callee),
        _ => false,
    }
}

fn is_registration_identifier_factory(checker: &mut Checker, callee: P<Node>) -> bool {
    let Some(symbol) = provenance::symbol_at_node(checker, callee) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    if !matches!(
        resolved.name(),
        "queryOptions" | "mutationOptions" | "infiniteQueryOptions"
    ) {
        return false;
    }
    boundary::symbol_package_path(checker, Some(symbol)).is_some_and(|pkg| {
        pkg.starts_with("@tanstack/react-query") || pkg.starts_with("@tanstack/query-core")
    })
}

fn is_registration_property_factory(checker: &mut Checker, callee: P<Node>) -> bool {
    let name_node = callee.as_property_access_expression().name();
    let Some(symbol) = provenance::symbol_at_node(checker, name_node) else {
        return false;
    };
    boundary::symbol_package_path(checker, Some(symbol)).is_some_and(|pkg| {
        pkg.starts_with("@trpc/") || pkg.starts_with("@orpc/") || pkg.starts_with("@tanstack/")
    })
}

fn is_registration_factory_call(checker: &mut Checker, node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if unwrapped.kind() != Kind::CallExpression {
        return false;
    }
    let callee = unwrapped.as_call_expression().expression();
    match callee.kind() {
        Kind::Identifier => is_registration_identifier_factory(checker, callee),
        Kind::PropertyAccessExpression => is_registration_property_factory(checker, callee),
        _ => false,
    }
}

fn direct_factory_result(decl: P<Node>) -> Option<P<Node>> {
    let fn_node = match decl.kind() {
        Kind::FunctionDeclaration => Some(decl),
        Kind::VariableDeclaration => decl
            .as_variable_declaration()
            .initializer()
            .map(tsrs_kernel::unwrap_expression)
            .filter(|node| tsrs_kernel::is_function_like(*node)),
        _ => None,
    }?;
    let body = fn_node.body()?;
    if body.kind() != Kind::Block {
        return Some(tsrs_kernel::unwrap_expression(body));
    }
    let stmts = body.as_block().statements().nodes();
    if stmts.len() == 1 && stmts[0].kind() == Kind::ReturnStatement {
        return stmts[0]
            .as_return_statement()
            .expression()
            .map(tsrs_kernel::unwrap_expression);
    }
    None
}

fn call_resolves_to_registration(checker: &mut Checker, call_node: P<Node>) -> bool {
    if is_registration_factory_call(checker, call_node) {
        return true;
    }
    let callee = call_node.as_call_expression().expression();
    let Some(symbol) = provenance::symbol_at_node(checker, callee) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    resolved.declarations().iter().copied().any(|decl| {
        direct_factory_result(decl).is_some_and(|res| is_registration_factory_call(checker, res))
    })
}

fn identifier_resolves_to_registration(
    checker: &mut Checker,
    ident_node: P<Node>,
    depth: usize,
) -> bool {
    let Some(symbol) = provenance::symbol_at_node(checker, ident_node) else {
        return false;
    };
    let resolved = provenance::resolve_aliased_symbol(checker, symbol);
    resolved.declarations().iter().copied().any(|decl| {
        decl.kind() == Kind::VariableDeclaration
            && decl
                .as_variable_declaration()
                .initializer()
                .is_some_and(|init| resolves_to_registration(checker, init, depth - 1))
    })
}

fn resolves_to_registration(checker: &mut Checker, node: P<Node>, depth: usize) -> bool {
    if depth == 0 {
        return false;
    }
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    match unwrapped.kind() {
        Kind::CallExpression => call_resolves_to_registration(checker, unwrapped),
        Kind::ObjectLiteralExpression => {
            let props = unwrapped
                .as_object_literal_expression()
                .properties()
                .nodes();
            !props.is_empty()
                && props.iter().copied().all(|prop| {
                    prop.kind() == Kind::SpreadAssignment
                        && resolves_to_registration(
                            checker,
                            prop.as_spread_assignment().expression(),
                            depth - 1,
                        )
                })
        }
        Kind::PropertyAccessExpression => {
            let prop = unwrapped.as_property_access_expression();
            prop.name().kind() == Kind::Identifier
                && prop.name().as_identifier().text() == "queryKey"
                && resolves_to_registration(checker, prop.expression(), depth - 1)
        }
        Kind::Identifier => identifier_resolves_to_registration(checker, unwrapped, depth),
        _ => false,
    }
}

fn is_tanstack_registration_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    if !is_tanstack_callee(checker, call.expression()) {
        return false;
    }
    let Some(&arg0) = call.arguments().nodes().first() else {
        return false;
    };
    resolves_to_registration(checker, arg0, 6)
}

impl Rule for NoExplicitTypeArgumentsOnOwnedApi {
    fn name(&self) -> &'static str {
        "antidrift/no-explicit-type-arguments-on-owned-api"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

const LISTENERS: [Listener; 1] = [Listener::Enter(Kind::CallExpression)];

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        &LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() != Kind::CallExpression || node.type_arguments().is_empty() {
            return;
        }
        if is_convex_hook_call(ctx.checker, node)
            || is_trpc_procedure_hook_call(ctx.checker, node)
            || is_swr_owned_fetcher_call(ctx.checker, node)
            || is_tanstack_registration_call(ctx.checker, node)
        {
            ctx.report_node(node, build_explicit_type_arguments_on_owned_api_message());
        }
    }
}
