use super::web_provenance::{ImportedOwner, imported_owner};
use antidrift_kernel::jsx::element_tag_name;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options, in_scope};
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unsanitized-href";

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct HrefOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    sanitizers: Vec<ImportedOwner>,
}

pub struct NoUnsanitizedHref {
    scope: RuleScope,
    sanitizers: Vec<ImportedOwner>,
}

pub static DEFAULT_RULE: NoUnsanitizedHref = NoUnsanitizedHref {
    scope: RuleScope::DEFAULT,
    sanitizers: Vec::new(),
};

impl NoUnsanitizedHref {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<HrefOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            scope,
            sanitizers: parsed.sanitizers,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::JsxAttribute)];

impl Rule for NoUnsanitizedHref {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor {
            rule: self,
            enabled,
        })
    }
}

struct Visitor {
    rule: &'static NoUnsanitizedHref,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let attr = node.as_jsx_attribute();
        let name = attr.name();
        if !ast::is_identifier(name) || name.as_identifier().text() != "href" {
            return;
        }
        let Some(opening) = node.parent().and_then(|attrs| attrs.parent()) else {
            return;
        };
        if element_tag_name(opening) != Some("a")
            || attr
                .initializer()
                .is_none_or(|init| safe_attribute(ctx.file, init, &self.rule.sanitizers))
        {
            return;
        }
        ctx.report_node(
            node,
            RuleMessage::new(
                "unsanitizedHref",
                "Sanitize dynamic href values through the imported URL-policy owner registered in sanitizers at the anchor sink to prevent javascript: XSS. Static http(s), mailto, fragment, and relative literals are allowed.",
            ),
        );
    }
}

fn safe_attribute(sf: P<SourceFile>, attribute: P<Node>, sanitizers: &[ImportedOwner]) -> bool {
    match attribute.kind() {
        Kind::StringLiteral => cooked_text(attribute).is_some_and(safe_prefix),
        Kind::JsxExpression => {
            attribute
                .as_jsx_expression()
                .expression()
                .is_some_and(|expression| match expression.kind() {
                    Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => {
                        cooked_text(expression).is_some_and(safe_prefix)
                    }
                    Kind::TemplateExpression => {
                        cooked_text(expression.as_template_expression().head())
                            .is_some_and(safe_prefix)
                    }
                    Kind::CallExpression => {
                        imported_owner(sf, expression.as_call_expression().expression(), sanitizers)
                    }
                    Kind::Identifier => expression.as_identifier().text() == "undefined",
                    Kind::NullKeyword => true,
                    _ => false,
                })
        }
        Kind::JsxElement | Kind::JsxSelfClosingElement | Kind::JsxFragment => true,
        _ => false,
    }
}

fn safe_prefix(href: &str) -> bool {
    ["https://", "http://", "/", "#", "mailto:"]
        .iter()
        .any(|prefix| href.starts_with(prefix))
}
