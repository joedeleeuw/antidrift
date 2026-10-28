use super::web_provenance::{
    AliasStability, ImportedOwner, const_initializer, imported_owner, property_name, symbol_for,
    unwrap_expression,
};
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options, in_scope};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unsafe-inner-html";

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct HtmlOptions {
    files: Option<Vec<String>>,
    exclude_files: Vec<String>,
    sanitizers: Option<Vec<ImportedOwner>>,
    trusted_sources: Vec<ImportedOwner>,
}

pub struct NoUnsafeInnerHtml {
    scope: RuleScope,
    sanitizers: Vec<ImportedOwner>,
    trusted_sources: Vec<ImportedOwner>,
}

pub static DEFAULT_RULE: NoUnsafeInnerHtml = NoUnsafeInnerHtml {
    scope: RuleScope::DEFAULT,
    sanitizers: Vec::new(),
    trusted_sources: Vec::new(),
};

impl NoUnsafeInnerHtml {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<HtmlOptions>(RULE_NAME, options)?;
        let scope_opts = ScopeOptions {
            files: parsed.files,
            exclude_files: parsed.exclude_files,
        };
        let scope = RuleScope::from_scope_options(RULE_NAME, &scope_opts)?;
        let sanitizers = parsed.sanitizers.unwrap_or_else(|| {
            vec![ImportedOwner {
                module: "dompurify".to_string(),
                export: "default".to_string(),
                member: Some("sanitize".to_string()),
            }]
        });
        Ok(Self {
            scope,
            sanitizers,
            trusted_sources: parsed.trusted_sources,
        })
    }

    fn effective_sanitizers(&self) -> Vec<ImportedOwner> {
        if self.sanitizers.is_empty() {
            vec![ImportedOwner {
                module: "dompurify".to_string(),
                export: "default".to_string(),
                member: Some("sanitize".to_string()),
            }]
        } else {
            self.sanitizers.clone()
        }
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxAttribute),
    Listener::Enter(Kind::BinaryExpression),
];

impl Rule for NoUnsafeInnerHtml {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        let sanitizers = if enabled {
            self.effective_sanitizers()
        } else {
            Vec::new()
        };
        Box::new(Visitor {
            rule: self,
            enabled,
            sanitizers,
        })
    }
}

struct Visitor {
    rule: &'static NoUnsafeInnerHtml,
    enabled: bool,
    sanitizers: Vec<ImportedOwner>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let policy = HtmlPolicy {
            sf: ctx.file,
            sanitizers: &self.sanitizers,
            trusted: &self.rule.trusted_sources,
        };
        match node.kind() {
            Kind::JsxAttribute => {
                let attr = node.as_jsx_attribute();
                let name = attr.name();
                if ast::is_identifier(name)
                    && name.as_identifier().text() == "dangerouslySetInnerHTML"
                    && let Some(init) = attr.initializer()
                    && init.kind() == Kind::JsxExpression
                    && let Some(expression) = init.as_jsx_expression().expression()
                {
                    inspect_payload(ctx, &policy, expression);
                }
            }
            Kind::BinaryExpression => {
                inspect_binary_inner_html(ctx, &policy, node);
            }
            _ => {}
        }
    }
}

fn inspect_binary_inner_html(ctx: &mut Ctx, policy: &HtmlPolicy, node: P<Node>) {
    let bin = node.as_binary_expression();
    if !ast::is_assignment_operator(bin.operator_token().kind())
        || bin.left().kind() != Kind::PropertyAccessExpression
    {
        return;
    }
    let prop = bin.left().as_property_access_expression().name();
    if ast::is_identifier(prop) && prop.as_identifier().text() == "innerHTML" {
        report_unsafe(ctx, policy, bin.right());
    }
}

struct HtmlPolicy<'a> {
    sf: P<SourceFile>,
    sanitizers: &'a [ImportedOwner],
    trusted: &'a [ImportedOwner],
}

impl HtmlPolicy<'_> {
    fn proven(&self, expression: P<Node>, visited: &mut Vec<Binding>) -> bool {
        let expression = unwrap_expression(expression);
        if literal_html(expression) || imported_owner(self.sf, expression, self.trusted) {
            return true;
        }
        if expression.kind() == Kind::CallExpression {
            return imported_owner(
                self.sf,
                expression.as_call_expression().expression(),
                self.sanitizers,
            );
        }
        if expression.kind() != Kind::Identifier {
            return false;
        }
        let Some(symbol) = symbol_for(expression) else {
            return false;
        };
        if visited.contains(&symbol) {
            return false;
        }
        visited.push(symbol);
        const_initializer(self.sf, symbol, AliasStability::Unwritten)
            .is_some_and(|initializer| self.proven(initializer, visited))
    }
}

fn literal_html(expression: P<Node>) -> bool {
    match expression.kind() {
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => true,
        Kind::TemplateExpression => expression
            .as_template_expression()
            .template_spans()
            .nodes()
            .iter()
            .all(|&span| literal_html(span.as_template_span().expression())),
        _ => false,
    }
}

fn inspect_payload(ctx: &mut Ctx, policy: &HtmlPolicy, expression: P<Node>) {
    let inner = unwrap_expression(expression);
    if inner.kind() != Kind::ObjectLiteralExpression {
        report_unsafe(ctx, policy, expression);
        return;
    }
    for &property in inner.as_object_literal_expression().properties().nodes() {
        match property.kind() {
            Kind::SpreadAssignment => {
                ctx.report_node(
                    property,
                    RuleMessage::new(
                        "unsafeInnerHtmlSpread",
                        "Do not spread an object into dangerouslySetInnerHTML. Keep `__html` inline so this rule can prove the HTML value is sanitized or escaped.",
                    ),
                );
            }
            Kind::PropertyAssignment => {
                let assign = property.as_property_assignment();
                if property_name(assign.name()) == Some("__html") {
                    report_unsafe(ctx, policy, assign.initializer());
                }
            }
            Kind::ShorthandPropertyAssignment => {
                let short = property.as_shorthand_property_assignment();
                if property_name(short.name()) == Some("__html") {
                    report_unsafe(ctx, policy, short.name());
                }
            }
            _ => {}
        }
    }
}

fn report_unsafe(ctx: &mut Ctx, policy: &HtmlPolicy, expression: P<Node>) {
    if !policy.proven(expression, &mut Vec::new()) {
        ctx.report_node(
            expression,
            RuleMessage::new(
                "unsafeInnerHtml",
                "Use an imported HTML sanitizer registered in sanitizers, or a trusted imported value registered in trustedSources. The DOM owner requires verifiable provenance for dynamic HTML.",
            ),
        );
    }
}
