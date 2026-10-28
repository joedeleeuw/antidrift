use antidrift_kernel::imports::FileImports;
use antidrift_kernel::jsx::function_returns_jsx;
use antidrift_kernel::local_binding::{Binding, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::unwrap_expression;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-calling-components-as-functions";
const IGNORED_NAMES: [&str; 1] = ["OverrideOrDefault"];
const COMPONENT_WRAPPERS: [&str; 2] = ["forwardRef", "memo"];
const NON_REACT_JSX_SOURCES: [&str; 3] = ["solid-js", "@builder.io/qwik", "vue"];

pub struct NoCallingComponentsAsFunctions {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoCallingComponentsAsFunctions = NoCallingComponentsAsFunctions {
    scope: RuleScope::DEFAULT,
};

impl NoCallingComponentsAsFunctions {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoCallingComponentsAsFunctions {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None) && !is_non_react_jsx_file(ctx.file);
        let imports = if enabled {
            FileImports::collect(ctx.file)
        } else {
            FileImports::default()
        };
        Box::new(Visitor { enabled, imports })
    }
}

struct Visitor {
    enabled: bool,
    imports: FileImports,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(name) = component_call_name(node, &self.imports) else {
            return;
        };
        ctx.report_node(
            node,
            RuleMessage::new(
                "noCallingComponentAsFunction",
                format!(
                    "\"{name}\" appears to be a React component. Use <{name} /> instead of calling it as a function."
                ),
            ),
        );
    }
}

fn component_call_name(call_node: P<Node>, imports: &FileImports) -> Option<&'static str> {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    if !ast::is_identifier(callee) {
        return None;
    }
    let name = callee.as_identifier().text();
    if !name.starts_with(|first: char| first.is_ascii_uppercase()) || should_skip(name) {
        return None;
    }
    let args = call.arguments().nodes();
    let accepted_arguments = args.is_empty()
        || (args.len() == 1
            && matches!(
                args[0].kind(),
                Kind::ObjectLiteralExpression | Kind::Identifier
            ));
    if !accepted_arguments {
        return None;
    }
    resolves_to_component(callee, imports, &mut FxHashSet::default()).then_some(name)
}

fn should_skip(name: &str) -> bool {
    IGNORED_NAMES.contains(&name) || name.ends_with("Fixture") || is_not_pascal_case(name)
}

fn is_not_pascal_case(name: &str) -> bool {
    let is_upper_or_digit = |ch: char| ch.is_ascii_uppercase() || ch.is_ascii_digit();
    let rest = &name[1..];
    let screaming_prefix = rest.trim_start_matches(is_upper_or_digit).starts_with('_');
    let screaming_case = rest.chars().all(|ch| is_upper_or_digit(ch) || ch == '_');
    screaming_prefix || screaming_case
}

fn is_module_or_subpath(source: &str, root: &str) -> bool {
    source
        .strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn is_non_react_jsx_file(sf: P<SourceFile>) -> bool {
    let mut imports_preact = false;
    let mut imports_preact_compat = false;
    for &statement in sf.statements().nodes() {
        if statement.kind() != Kind::ImportDeclaration {
            continue;
        }
        let spec = statement.as_import_declaration().module_specifier();
        if !ast::is_string_literal(spec) {
            continue;
        }
        let source = spec.as_string_literal().text();
        if NON_REACT_JSX_SOURCES
            .iter()
            .any(|root| is_module_or_subpath(source, root))
        {
            return true;
        }
        if is_module_or_subpath(source, "preact/compat") {
            imports_preact_compat = true;
        } else if is_module_or_subpath(source, "preact") {
            imports_preact = true;
        }
    }
    imports_preact && !imports_preact_compat
}

fn is_component_wrapper_call(call_node: P<Node>, imports: &FileImports) -> bool {
    imports.is_unshadowed_call(
        call_node.as_call_expression().expression(),
        "react",
        &COMPONENT_WRAPPERS,
    )
}

fn resolves_to_component(
    identifier: P<Node>,
    imports: &FileImports,
    seen: &mut FxHashSet<Binding>,
) -> bool {
    let Some(binding) = resolve_lexical_binding(identifier) else {
        return false;
    };
    if !seen.insert(binding) {
        return false;
    }
    match binding.decl.kind() {
        Kind::FunctionDeclaration => function_returns_jsx(binding.decl),
        Kind::VariableDeclaration => {
            if binding
                .decl
                .name()
                .is_none_or(|name| !ast::is_identifier(name))
            {
                return false;
            }
            binding
                .decl
                .as_variable_declaration()
                .initializer()
                .is_some_and(|init| initializer_is_component(init, imports, seen))
        }
        _ => false,
    }
}

fn initializer_is_component(
    init: P<Node>,
    imports: &FileImports,
    seen: &mut FxHashSet<Binding>,
) -> bool {
    let inner = unwrap_expression(init);
    match inner.kind() {
        Kind::Identifier => resolves_to_component(inner, imports, seen),
        Kind::FunctionExpression | Kind::ArrowFunction => function_returns_jsx(inner),
        Kind::CallExpression => is_component_wrapper_call(inner, imports),
        _ => false,
    }
}
