use antidrift_kernel::local_binding::{Binding, is_binding_mutated, resolve_lexical_binding};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{cooked_text, numeric_literal_value, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-path-prefix-containment";

pub struct NoPathPrefixContainment {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoPathPrefixContainment = NoPathPrefixContainment {
    scope: RuleScope::DEFAULT,
};

impl NoPathPrefixContainment {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoPathPrefixContainment {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let provenance = PathProvenance { sf: ctx.file };
        if bare_path_prefix(node, &provenance) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "noPathPrefixContainment",
                    "A bare path prefix also accepts sibling paths such as '<root>-backup'. Use path.relative() with '..' and absolute-path checks, or an approved boundary-aware containment helper.",
                ),
            );
        }
    }
}

struct PathProvenance {
    sf: P<SourceFile>,
}

impl PathProvenance {
    fn stable(&self, expression: P<Node>) -> P<Node> {
        let mut current = unwrap_expression(expression);
        let mut visited = FxHashSet::default();
        while current.kind() == Kind::Identifier {
            let Some(binding) = resolve_lexical_binding(current) else {
                break;
            };
            if !visited.insert(binding) || is_binding_mutated(self.sf.as_node(), binding) {
                break;
            }
            if binding.decl.kind() != Kind::VariableDeclaration {
                break;
            }
            let Some(initializer) = binding.decl.as_variable_declaration().initializer() else {
                break;
            };
            current = unwrap_expression(initializer);
        }
        current
    }

    fn same_stable(&self, left: P<Node>, right: P<Node>) -> bool {
        let left = self.stable(left);
        let right = self.stable(right);
        if left == right {
            return true;
        }
        match (left.kind(), right.kind()) {
            (Kind::Identifier, Kind::Identifier) => resolve_lexical_binding(left)
                .is_some_and(|symbol| resolve_lexical_binding(right) == Some(symbol)),
            (Kind::StringLiteral, Kind::StringLiteral) => {
                cooked_text(left).is_some_and(|text| cooked_text(right) == Some(text))
            }
            _ => false,
        }
    }
}

fn path_api(expression: P<Node>, api: &str) -> bool {
    let mut parts = Vec::new();
    let mut current = unwrap_expression(expression);
    while let Some((object, property)) = member_parts(current) {
        parts.push(property);
        current = unwrap_expression(object);
    }
    if current.kind() != Kind::Identifier {
        return false;
    }
    let Some(binding) = resolve_lexical_binding(current) else {
        return false;
    };
    if !push_imported_part(binding, &mut parts) {
        return false;
    }
    let Some(source) = enclosing_import_source(binding.decl) else {
        return false;
    };
    matches!(source, "path" | "node:path")
        && parts.first().copied() == Some(api)
        && (parts.len() == 1 || (parts.len() == 2 && matches!(parts[1], "posix" | "win32")))
}

fn push_imported_part(binding: Binding, parts: &mut Vec<&'static str>) -> bool {
    match binding.decl.kind() {
        Kind::ImportSpecifier => {
            let spec = binding.decl.as_import_specifier();
            let imported = spec.property_name().unwrap_or_else(|| spec.name());
            match imported.kind() {
                Kind::Identifier => parts.push(imported.as_identifier().text()),
                Kind::StringLiteral => {
                    let Some(part) = cooked_text(imported) else {
                        return false;
                    };
                    parts.push(part);
                }
                _ => return false,
            }
            true
        }
        Kind::ImportClause | Kind::NamespaceImport => true,
        _ => false,
    }
}

fn enclosing_import_source(node: P<Node>) -> Option<&'static str> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if ancestor.kind() == Kind::ImportDeclaration {
            let spec = ancestor.as_import_declaration().module_specifier();
            return ast::is_string_literal(spec)
                .then_some(spec)
                .and_then(cooked_text);
        }
        cursor = ancestor.parent();
    }
    None
}

fn member_parts(expression: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => {
            let access = inner.as_property_access_expression();
            let name = access.name();
            ast::is_identifier(name).then(|| (access.expression(), name.as_identifier().text()))
        }
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            let arg = access.argument_expression();
            let prop = match arg.kind() {
                Kind::Identifier => Some(arg.as_identifier().text()),
                Kind::StringLiteral => cooked_text(arg),
                _ => None,
            }?;
            Some((access.expression(), prop))
        }
        _ => None,
    }
}

fn call_expression(expression: P<Node>) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    (inner.kind() == Kind::CallExpression).then_some(inner)
}

fn bare_path_prefix(call_node: P<Node>, provenance: &PathProvenance) -> bool {
    let call = call_node.as_call_expression();
    let Some((object, method)) = member_parts(call.expression()) else {
        return false;
    };
    let args = call.arguments().nodes();
    if method != "startsWith" || !(1..=2).contains(&args.len()) {
        return false;
    }
    if args.len() == 2
        && (args[1].kind() == Kind::SpreadElement || !zero_start(args[1], provenance))
    {
        return false;
    }
    if args[0].kind() != Kind::SpreadElement && separator_suffix(args[0], provenance) {
        return false;
    }
    let Some(candidate) = call_expression(provenance.stable(object)) else {
        return false;
    };
    let candidate_callee = candidate.as_call_expression().expression();
    ["dirname", "join", "normalize", "resolve"]
        .iter()
        .any(|api| path_api(candidate_callee, api))
}

fn zero_start(expression: P<Node>, provenance: &PathProvenance) -> bool {
    let stable = provenance.stable(expression);
    match stable.kind() {
        Kind::NumericLiteral => numeric_literal_value(stable) == Some(0.0),
        Kind::PrefixUnaryExpression => {
            let unary = stable.as_prefix_unary_expression();
            matches!(unary.operator(), Kind::PlusToken | Kind::MinusToken)
                && numeric_literal_value(unwrap_expression(unary.operand())) == Some(0.0)
        }
        _ => false,
    }
}

fn separator(expression: P<Node>, provenance: &PathProvenance) -> bool {
    let expression = provenance.stable(expression);
    (expression.kind() == Kind::StringLiteral
        && matches!(cooked_text(expression), Some("/" | "\\")))
        || path_api(expression, "sep")
}

fn separator_suffix(expression: P<Node>, provenance: &PathProvenance) -> bool {
    let stable = provenance.stable(expression);
    match stable.kind() {
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => {
            cooked_text(stable).is_some_and(|text| text.ends_with(['/', '\\']))
        }
        Kind::ConditionalExpression => conditional_suffix(stable, provenance),
        Kind::BinaryExpression => {
            let bin = stable.as_binary_expression();
            bin.operator_token().kind() == Kind::PlusToken && separator(bin.right(), provenance)
        }
        Kind::TemplateExpression => {
            let spans = stable.as_template_expression().template_spans().nodes();
            let Some(&last_span_node) = spans.last() else {
                return false;
            };
            let last_span = last_span_node.as_template_span();
            let Some(trailing) = cooked_text(last_span.literal()) else {
                return false;
            };
            trailing.ends_with(['/', '\\'])
                || (trailing.is_empty() && separator(last_span.expression(), provenance))
        }
        _ => false,
    }
}

fn conditional_suffix(conditional_node: P<Node>, provenance: &PathProvenance) -> bool {
    let conditional = conditional_node.as_conditional_expression();
    if separator_suffix(conditional.when_true(), provenance)
        && separator_suffix(conditional.when_false(), provenance)
    {
        return true;
    }
    let Some(call_node) = call_expression(conditional.condition()) else {
        return false;
    };
    let call = call_node.as_call_expression();
    let Some((object, method)) = member_parts(call.expression()) else {
        return false;
    };
    let args = call.arguments().nodes();
    method == "endsWith"
        && args.len() == 1
        && args[0].kind() != Kind::SpreadElement
        && separator(args[0], provenance)
        && provenance.same_stable(object, conditional.when_true())
        && separator_suffix(conditional.when_false(), provenance)
}
