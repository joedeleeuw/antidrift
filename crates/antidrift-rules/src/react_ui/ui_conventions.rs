use antidrift_kernel::imports::FileImports;
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleSpec, RuleVisitor};
use antidrift_kernel::string_fragments::string_fragments;
use antidrift_kernel::tsrs_kernel::{cooked_text, unwrap_parentheses};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const IMPORT_LISTENERS: &[Listener] = &[Listener::Enter(Kind::ImportDeclaration)];
const CALL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];
const VAR_DECL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::VariableDeclaration)];

const HOTKEY_MODULES: [&str; 2] = ["@tanstack/hotkeys", "@tanstack/react-hotkeys"];
const AMBIENT_EXPORTS: [&str; 2] = ["detectPlatform", "formatForDisplay"];
const HOTKEY_MESSAGE: &str = "Ambient hotkey platform reads can differ between SSR and hydration. Use useHydrationSafeHotkeyPlatform() with formatHotkeyForPlatform().";

const UTILITY_PREFIXES: [&str; 5] = ["text", "decoration", "bg", "border", "ring"];
const FOREGROUND_TOKENS: [&str; 2] = ["muted-foreground", "foreground"];
const RAW_OPACITIES: [&str; 8] = ["40", "45", "50", "60", "64", "70", "72", "80"];

const EFFECT_HOOKS: [&str; 2] = ["useEffect", "useLayoutEffect"];
const PANIC_MESSAGE: &str = "Terminate this unreachable branch with a throw or the configured exhaustive-failure owner; a never annotation has no runtime effect.";

pub static NO_AMBIENT_HOTKEY_FORMAT: RuleSpec = RuleSpec::new(
    "antidrift/no-ambient-hotkey-format",
    IMPORT_LISTENERS,
    visit_ambient_hotkey_format,
);

pub static NO_RAW_FOREGROUND_OPACITY: RuleSpec = RuleSpec::new(
    "antidrift/no-raw-foreground-opacity",
    &[],
    visit_raw_foreground_opacity,
);

fn visit_ambient_hotkey_format(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let decl = node.as_import_declaration();
    let spec = decl.module_specifier();
    if !ast::is_string_literal(spec)
        || !cooked_text(spec).is_some_and(|module| HOTKEY_MODULES.contains(&module))
    {
        return;
    }
    let Some(clause_node) = decl.import_clause() else {
        return;
    };
    let Some(bindings) = clause_node.as_import_clause().named_bindings() else {
        return;
    };
    match bindings.kind() {
        Kind::NamespaceImport => {
            ctx.report_node(
                bindings,
                RuleMessage::new("ambientHotkeyFormat", HOTKEY_MESSAGE),
            );
        }
        Kind::NamedImports => {
            report_named_hotkey_imports(ctx, bindings.as_named_imports().elements().nodes());
        }
        _ => {}
    }
}

fn report_named_hotkey_imports(ctx: &mut Ctx, elements: &[P<Node>]) {
    for &elem in elements {
        if is_ambient_specifier(elem) {
            ctx.report_node(
                elem,
                RuleMessage::new("ambientHotkeyFormat", HOTKEY_MESSAGE),
            );
        }
    }
}

fn is_ambient_specifier(specifier: P<Node>) -> bool {
    if specifier.kind() != Kind::ImportSpecifier {
        return false;
    }
    let spec = specifier.as_import_specifier();
    let imported = spec.property_name().unwrap_or_else(|| spec.name());
    let name = match imported.kind() {
        Kind::Identifier => Some(imported.as_identifier().text()),
        Kind::StringLiteral => cooked_text(imported),
        _ => None,
    };
    name.is_some_and(|name| AMBIENT_EXPORTS.contains(&name))
}

fn visit_raw_foreground_opacity(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
    for fragment in string_fragments(ctx.file) {
        let Some(token) = fragment
            .text
            .split_whitespace()
            .find(|token| is_raw_foreground_opacity(token))
        else {
            continue;
        };
        ctx.report_node(
            fragment.node,
            RuleMessage::new(
                "rawForegroundOpacity",
                format!(
                    "Raw foreground opacity '{token}' hides visual intent. Use a named token such as text-foreground-muted, text-foreground-placeholder, border-foreground-disabled, or text-foreground-strong-muted."
                ),
            ),
        );
    }
}

fn opacity_suffix_matches(rest: &str) -> bool {
    RAW_OPACITIES.iter().any(|opacity| {
        rest.strip_prefix(opacity).is_some_and(|after| {
            after
                .chars()
                .next()
                .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'))
        })
    })
}

fn matches_raw_opacity_at(token: &str) -> bool {
    UTILITY_PREFIXES.iter().any(|prefix| {
        token
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|rest| {
                FOREGROUND_TOKENS.iter().any(|color| {
                    rest.strip_prefix(color)
                        .and_then(|after| after.strip_prefix('/'))
                        .is_some_and(opacity_suffix_matches)
                })
            })
    })
}

fn is_raw_foreground_opacity(token: &str) -> bool {
    matches_raw_opacity_at(token)
        || token
            .match_indices(':')
            .any(|(index, _)| matches_raw_opacity_at(&token[index + 1..]))
}

pub struct RequireEffectDeps;

pub static REQUIRE_EFFECT_DEPS: RequireEffectDeps = RequireEffectDeps;

impl Rule for RequireEffectDeps {
    fn name(&self) -> &'static str {
        "antidrift/require-effect-deps"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let imports = FileImports::collect(ctx.file);
        let direct = imports.locals_from("react", &EFFECT_HOOKS);
        let namespaces = imports.namespaces_from("react");
        Box::new(EffectDepsVisitor { direct, namespaces })
    }
}

struct EffectDepsVisitor {
    direct: FxHashSet<&'static str>,
    namespaces: FxHashSet<&'static str>,
}

impl EffectDepsVisitor {
    fn hook_name(&self, call_node: P<Node>) -> Option<&'static str> {
        let callee = call_node.as_call_expression().expression();
        match callee.kind() {
            Kind::Identifier => {
                let name = callee.as_identifier().text();
                self.direct.contains(name).then_some(name)
            }
            Kind::PropertyAccessExpression => {
                let access = callee.as_property_access_expression();
                let prop = access.name();
                let obj = access.expression();
                if !ast::is_identifier(prop) || !ast::is_identifier(obj) {
                    return None;
                }
                let property = prop.as_identifier().text();
                (self.namespaces.contains(obj.as_identifier().text())
                    && EFFECT_HOOKS.contains(&property))
                .then_some(property)
            }
            _ => None,
        }
    }
}

impl RuleVisitor for EffectDepsVisitor {
    fn listeners(&self) -> &[Listener] {
        if self.direct.is_empty() && self.namespaces.is_empty() {
            &[]
        } else {
            CALL_LISTENERS
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(hook) = self.hook_name(node) else {
            return;
        };
        if node.as_call_expression().arguments().nodes().len() < 2 {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "missingDeps",
                    format!(
                        "{hook} must declare its dependency array. Pass the dependencies the effect reads. If every-render execution is intentional, keep it and suppress antidrift/require-effect-deps with a reason rather than adding []."
                    ),
                ),
            );
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct ExhaustivePanicOptions {
    failure_functions: Vec<String>,
}

pub struct RequireExhaustivePanic {
    failure_functions: Vec<String>,
}

pub static REQUIRE_EXHAUSTIVE_PANIC: RequireExhaustivePanic = RequireExhaustivePanic {
    failure_functions: Vec::new(),
};

impl crate::ConfigurableRule for RequireExhaustivePanic {
    type Options = ExhaustivePanicOptions;

    fn from_options(parsed: Self::Options) -> Result<Self, String> {
        Ok(Self {
            failure_functions: parsed.failure_functions,
        })
    }
}

impl Rule for RequireExhaustivePanic {
    fn name(&self) -> &'static str {
        "antidrift/require-exhaustive-panic"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(ExhaustivePanicVisitor { rule: self })
    }
}

struct ExhaustivePanicVisitor {
    rule: &'static RequireExhaustivePanic,
}

impl RuleVisitor for ExhaustivePanicVisitor {
    fn listeners(&self) -> &[Listener] {
        VAR_DECL_LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let is_never = node
            .as_variable_declaration()
            .type_()
            .is_some_and(|annotation| annotation.kind() == Kind::NeverKeyword);
        if !is_never {
            return;
        }
        let Some(var_stmt) = node.parent().and_then(|list| list.parent()) else {
            return;
        };
        if var_stmt.kind() != Kind::VariableStatement {
            return;
        }
        let Some(statements) = sibling_statements(var_stmt) else {
            return;
        };
        if !terminates(statements, var_stmt, &self.rule.failure_functions) {
            ctx.report_node(node, RuleMessage::new("exhaustive", PANIC_MESSAGE));
        }
    }
}

fn sibling_statements(var_stmt: P<Node>) -> Option<&'static [P<Node>]> {
    let parent = var_stmt.parent()?;
    match parent.kind() {
        Kind::SourceFile => Some(parent.as_source_file().statements().nodes()),
        Kind::Block => Some(parent.as_block().statements().nodes()),
        Kind::CaseClause | Kind::DefaultClause => {
            Some(parent.as_case_or_default_clause().statements().nodes())
        }
        Kind::ClassStaticBlockDeclaration => Some(
            parent
                .as_class_static_block_declaration()
                .body()
                .as_block()
                .statements()
                .nodes(),
        ),
        Kind::ModuleBlock => Some(parent.as_module_block().statements().nodes()),
        _ => None,
    }
}

fn calls_failure(statement: P<Node>, failures: &[String]) -> bool {
    let expression = match statement.kind() {
        Kind::ReturnStatement => statement.as_return_statement().expression(),
        Kind::ExpressionStatement => Some(statement.as_expression_statement().expression()),
        _ => None,
    };
    let Some(inner) = expression.map(unwrap_parentheses) else {
        return false;
    };
    if inner.kind() != Kind::CallExpression {
        return false;
    }
    let callee = inner.as_call_expression().expression();
    ast::is_identifier(callee)
        && failures
            .iter()
            .any(|name| name == callee.as_identifier().text())
}

fn terminates(statements: &[P<Node>], declaration: P<Node>, failures: &[String]) -> bool {
    statements
        .iter()
        .copied()
        .skip_while(|&statement| statement != declaration)
        .skip(1)
        .any(|statement| {
            statement.kind() == Kind::ThrowStatement || calls_failure(statement, failures)
        })
}
