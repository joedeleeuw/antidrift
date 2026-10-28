use super::no_placeholder_tests::is_test_filename;
use super::repo_state_path::source_file_read_call_name;
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-repo-state-mirror-assertion";

const EQUALITY_MATCHERS: &[&str] = &[
    "toBe",
    "toEqual",
    "toStrictEqual",
    "toMatchObject",
    "toContain",
    "toContainEqual",
    "toHaveProperty",
    "toMatch",
    "toMatchSnapshot",
    "toMatchInlineSnapshot",
];

const SNAPSHOT_MATCHERS: &[&str] = &["toMatchSnapshot", "toMatchInlineSnapshot"];

const EXISTENCE_MATCHERS: &[&str] = &[
    "toBeNull",
    "toBeUndefined",
    "toBeDefined",
    "toBeTruthy",
    "toBeFalsy",
];

const CHAIN_MODIFIERS: &[&str] = &["not", "resolves", "rejects"];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct RepoStateMirrorOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    sources: Vec<RepoStateSourceOption>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct RepoStateSourceOption {
    module: String,
    names: Option<Vec<String>>,
}

pub struct NoRepoStateMirrorAssertion {
    scope: RuleScope,
    sources: Vec<RepoStateSourceOption>,
}

pub static DEFAULT_RULE: NoRepoStateMirrorAssertion = NoRepoStateMirrorAssertion {
    scope: RuleScope::DEFAULT,
    sources: Vec::new(),
};

impl NoRepoStateMirrorAssertion {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<RepoStateMirrorOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            scope,
            sources: parsed.sources,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoRepoStateMirrorAssertion {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let normalized_path = ctx.file.file_name().replace('\\', "/");
        let in_scope = self.scope.matches(&normalized_path, cwd)
            && (normalized_path.is_empty()
                || normalized_path == "<input>"
                || normalized_path == "<text>"
                || is_test_filename(&normalized_path));
        let tainted_imports = if in_scope {
            collect_tainted_imports(ctx.file.statements().nodes(), &self.sources)
        } else {
            FxHashMap::default()
        };
        Box::new(Visitor {
            enabled: in_scope,
            tainted_imports,
        })
    }
}

struct Visitor {
    enabled: bool,
    tainted_imports: FxHashMap<String, String>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        check_assertion_call(ctx, node, &self.tainted_imports);
    }
}

fn collect_tainted_imports(
    stmts: &[P<Node>],
    sources: &[RepoStateSourceOption],
) -> FxHashMap<String, String> {
    let mut tainted = FxHashMap::default();
    if sources.is_empty() {
        return tainted;
    }
    for &stmt in stmts {
        if stmt.kind() == Kind::ImportDeclaration {
            collect_from_import_decl(stmt, sources, &mut tainted);
        }
    }
    tainted
}

fn collect_from_import_decl(
    import_node: P<Node>,
    sources: &[RepoStateSourceOption],
    tainted: &mut FxHashMap<String, String>,
) {
    let import_decl = import_node.as_import_declaration();
    let spec_lit = import_decl.module_specifier();
    if !ast::is_string_literal(spec_lit) {
        return;
    }
    let module_specifier = spec_lit.as_string_literal().text();
    let Some(clause_node) = import_decl.import_clause() else {
        return;
    };
    let clause = clause_node.as_import_clause();
    if let Some(default_name) = clause.name()
        && ast::is_identifier(default_name)
    {
        let local = default_name.as_identifier().text();
        if let Some(matched) = source_for_import(sources, module_specifier, local) {
            tainted.insert(local.to_string(), matched.to_string());
        }
    }
    let Some(bindings) = clause.named_bindings() else {
        return;
    };
    match bindings.kind() {
        Kind::NamespaceImport => {
            if let Some(ns_name) = bindings.name()
                && ast::is_identifier(ns_name)
            {
                let local = ns_name.as_identifier().text();
                if let Some(matched) = source_for_import(sources, module_specifier, local) {
                    tainted.insert(local.to_string(), matched.to_string());
                }
            }
        }
        Kind::NamedImports => {
            for &spec in bindings.as_named_imports().elements().nodes() {
                if spec.kind() == Kind::ImportSpecifier {
                    record_named_specifier(spec, sources, module_specifier, tainted);
                }
            }
        }
        _ => {}
    }
}

fn record_named_specifier(
    spec: P<Node>,
    sources: &[RepoStateSourceOption],
    module_specifier: &str,
    tainted: &mut FxHashMap<String, String>,
) {
    let Some(local_node) = spec.name() else {
        return;
    };
    if !ast::is_identifier(local_node) {
        return;
    }
    let local_name = local_node.as_identifier().text();
    let imported_name = spec
        .as_import_specifier()
        .property_name()
        .and_then(|prop| ast::is_identifier(prop).then(|| prop.as_identifier().text()))
        .unwrap_or(local_name);
    if let Some(matched) = source_for_import(sources, module_specifier, imported_name) {
        tainted.insert(local_name.to_string(), matched.to_string());
    }
}

fn source_for_import<'a>(
    sources: &'a [RepoStateSourceOption],
    module_specifier: &str,
    imported_name: &'a str,
) -> Option<&'a str> {
    for source in sources {
        if !module_specifier.contains(&source.module) {
            continue;
        }
        let matches_name = source
            .names
            .as_ref()
            .is_none_or(|names| names.iter().any(|n| n == imported_name));
        if matches_name {
            return Some(imported_name);
        }
    }
    None
}

fn check_assertion_call(
    ctx: &mut Ctx<'_>,
    call_node: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
) {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return;
    }
    let access = callee.as_property_access_expression();
    let prop_node = access.name();
    if !ast::is_identifier(prop_node) {
        return;
    }
    let matcher = prop_node.as_identifier().text();
    let is_equality = EQUALITY_MATCHERS.contains(&matcher);
    let is_existence = EXISTENCE_MATCHERS.contains(&matcher);
    if !is_equality && !is_existence {
        return;
    }
    let Some(expect_call) = expect_call_of(access.expression()) else {
        return;
    };
    let Some(&subject_expr) = expect_call.as_call_expression().arguments().nodes().first() else {
        return;
    };
    if subject_expr.kind() == Kind::SpreadElement {
        return;
    }
    if is_equality {
        let args = call.arguments().nodes();
        let is_snapshot = SNAPSHOT_MATCHERS.contains(&matcher);
        if !is_snapshot && args.is_empty() {
            return;
        }
        if !args
            .iter()
            .all(|&arg| arg.kind() != Kind::SpreadElement && is_literal_like(arg))
        {
            return;
        }
        let mut visited_syms = FxHashSet::default();
        if let Some(name) = taint_root_name(subject_expr, tainted_imports, &mut visited_syms) {
            ctx.report_node(
                call_node,
                RuleMessage::new(
                    "mirroredLiteral",
                    format!(
                        "This assertion mirrors repo-owned state loaded through \"{name}\" against a literal. It restates values the repo already defines and breaks on every legitimate tune. Assert an invariant or behavior, or arrange the data as a fixture the test owns."
                    ),
                ),
            );
        }
        return;
    }
    if let Some(pinned) = literal_keyed_source_call(subject_expr, tainted_imports) {
        ctx.report_node(
            call_node,
            RuleMessage::new(
                "pinnedLookup",
                format!(
                    "This assertion pins the presence of a specific key in repo-owned state via \"{pinned}\". A row existing is data, not behavior. Assert an invariant, or arrange the data as a fixture the test owns."
                ),
            ),
        );
    }
}

fn expect_call_of(expr: P<Node>) -> Option<P<Node>> {
    let mut receiver = unwrap_expr(expr);
    while receiver.kind() == Kind::PropertyAccessExpression {
        let access = receiver.as_property_access_expression();
        let prop = access.name();
        if !ast::is_identifier(prop) || !CHAIN_MODIFIERS.contains(&prop.as_identifier().text()) {
            break;
        }
        receiver = unwrap_expr(access.expression());
    }
    if receiver.kind() != Kind::CallExpression {
        return None;
    }
    let call = receiver.as_call_expression();
    let callee = unwrap_expr(call.expression());
    (ast::is_identifier(callee)
        && callee.as_identifier().text() == "expect"
        && !call.arguments().nodes().is_empty())
    .then_some(receiver)
}

pub(super) fn unwrap_expr(mut expr: P<Node>) -> P<Node> {
    loop {
        match expr.kind() {
            Kind::ParenthesizedExpression => {
                expr = expr.as_parenthesized_expression().expression();
            }
            Kind::NonNullExpression => expr = expr.as_non_null_expression().expression(),
            Kind::AsExpression => expr = expr.as_as_expression().expression(),
            Kind::SatisfiesExpression => expr = expr.as_satisfies_expression().expression(),
            Kind::AwaitExpression => expr = expr.as_await_expression().expression(),
            _ => return expr,
        }
    }
}

fn is_literal_like(expr: P<Node>) -> bool {
    let inner = unwrap_expr(expr);
    match inner.kind() {
        Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::NullKeyword
        | Kind::NumericLiteral
        | Kind::BigIntLiteral
        | Kind::RegularExpressionLiteral
        | Kind::StringLiteral
        | Kind::NoSubstitutionTemplateLiteral => true,
        Kind::Identifier => inner.as_identifier().text() == "undefined",
        Kind::PrefixUnaryExpression => {
            let unary = inner.as_prefix_unary_expression();
            matches!(unary.operator(), Kind::MinusToken | Kind::PlusToken)
                && is_literal_like(unary.operand())
        }
        Kind::ObjectLiteralExpression => inner
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .all(|&prop| match prop.kind() {
                Kind::PropertyAssignment => {
                    let assign = prop.as_property_assignment();
                    assign.name().kind() != Kind::ComputedPropertyName
                        && is_literal_like(assign.initializer())
                }
                Kind::ShorthandPropertyAssignment => {
                    is_literal_like(prop.as_shorthand_property_assignment().name())
                }
                _ => false,
            }),
        Kind::ArrayLiteralExpression => inner
            .as_array_literal_expression()
            .elements()
            .nodes()
            .iter()
            .all(|&elem| {
                !matches!(elem.kind(), Kind::SpreadElement | Kind::OmittedExpression)
                    && is_literal_like(elem)
            }),
        _ => false,
    }
}

fn taint_root_name(
    expr: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
    visited_syms: &mut FxHashSet<Binding>,
) -> Option<String> {
    let target = unwrap_expr(expr);
    match target.kind() {
        Kind::Identifier => {
            let name = target.as_identifier().text();
            if tainted_imports.contains_key(name) {
                return Some(name.to_string());
            }
            let binding = resolve_lexical_binding(target)?;
            if !visited_syms.insert(binding) {
                return None;
            }
            binding_is_tainted(binding, tainted_imports, visited_syms).then(|| name.to_string())
        }
        Kind::CallExpression => source_file_read_call_name(target).or_else(|| {
            taint_root_name(
                target.as_call_expression().expression(),
                tainted_imports,
                visited_syms,
            )
        }),
        Kind::PropertyAccessExpression => taint_root_name(
            target.as_property_access_expression().expression(),
            tainted_imports,
            visited_syms,
        ),
        Kind::ElementAccessExpression => taint_root_name(
            target.as_element_access_expression().expression(),
            tainted_imports,
            visited_syms,
        ),
        Kind::ConditionalExpression => {
            let cond = target.as_conditional_expression();
            taint_root_name(cond.when_true(), tainted_imports, visited_syms)
                .or_else(|| taint_root_name(cond.when_false(), tainted_imports, visited_syms))
        }
        Kind::BinaryExpression => {
            let bin = target.as_binary_expression();
            if matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) {
                taint_root_name(bin.left(), tainted_imports, visited_syms)
                    .or_else(|| taint_root_name(bin.right(), tainted_imports, visited_syms))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn binding_is_tainted(
    binding: Binding,
    tainted_imports: &FxHashMap<String, String>,
    visited_syms: &mut FxHashSet<Binding>,
) -> bool {
    match binding.decl.kind() {
        Kind::VariableDeclaration => {
            if let Some(init) = binding.decl.as_variable_declaration().initializer()
                && taint_root_name(init, tainted_imports, visited_syms).is_some()
            {
                return true;
            }
            if let Some(list) = binding.decl.parent()
                && list.kind() == Kind::VariableDeclarationList
                && let Some(for_of) = list.parent()
                && for_of.kind() == Kind::ForOfStatement
            {
                return taint_root_name(
                    for_of.as_for_in_or_of_statement().expression(),
                    tainted_imports,
                    visited_syms,
                )
                .is_some();
            }
            false
        }
        Kind::Parameter => {
            let Some(func) = binding.decl.parent() else {
                return false;
            };
            let Some(call) = func.parent() else {
                return false;
            };
            if call.kind() == Kind::CallExpression {
                let callee = call.as_call_expression().expression();
                if callee.kind() == Kind::PropertyAccessExpression {
                    return taint_root_name(
                        callee.as_property_access_expression().expression(),
                        tainted_imports,
                        visited_syms,
                    )
                    .is_some();
                }
            }
            false
        }
        _ => false,
    }
}

fn literal_keyed_source_call(
    expr: P<Node>,
    tainted_imports: &FxHashMap<String, String>,
) -> Option<String> {
    let inner = unwrap_expr(expr);
    match inner.kind() {
        Kind::CallExpression => {
            let call = inner.as_call_expression();
            let callee = unwrap_expr(call.expression());
            let args = call.arguments().nodes();
            if ast::is_identifier(callee)
                && tainted_imports.contains_key(callee.as_identifier().text())
                && !args.is_empty()
                && args
                    .iter()
                    .all(|&arg| arg.kind() != Kind::SpreadElement && is_literal_like(arg))
            {
                return Some(callee.as_identifier().text().to_string());
            }
            literal_keyed_source_call(call.expression(), tainted_imports)
        }
        Kind::PropertyAccessExpression => literal_keyed_source_call(
            inner.as_property_access_expression().expression(),
            tainted_imports,
        ),
        Kind::ElementAccessExpression => literal_keyed_source_call(
            inner.as_element_access_expression().expression(),
            tainted_imports,
        ),
        _ => None,
    }
}
