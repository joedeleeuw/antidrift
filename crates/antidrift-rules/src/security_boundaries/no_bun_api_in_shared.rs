use antidrift_kernel::file_role::ProjectPath;
use antidrift_kernel::local_binding::resolve_lexical_binding;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-bun-api-in-shared";

pub struct NoBunApiInShared {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoBunApiInShared = NoBunApiInShared {
    scope: RuleScope::DEFAULT,
};

impl NoBunApiInShared {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::PropertyAccessExpression),
    Listener::Enter(Kind::ElementAccessExpression),
];

impl Rule for NoBunApiInShared {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, Some(shared_file));
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
        let violation = match node.kind() {
            Kind::ImportDeclaration => {
                let spec = node.as_import_declaration().module_specifier();
                ast::is_string_literal(spec)
                    && cooked_text(spec)
                        .is_some_and(|source| source == "bun" || source.starts_with("bun:"))
            }
            Kind::PropertyAccessExpression => {
                unbound_bun(node.as_property_access_expression().expression())
            }
            Kind::ElementAccessExpression => {
                unbound_bun(node.as_element_access_expression().expression())
            }
            _ => false,
        };
        if violation {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "runtime",
                    "Keep shared code runtime independent; move Bun APIs into the runtime adapter owner.",
                ),
            );
        }
    }
}

fn shared_file(path: &ProjectPath) -> bool {
    path.as_str().starts_with("shared/") || path.as_str().contains("/shared/")
}

fn unbound_bun(expression: P<Node>) -> bool {
    expression.kind() == Kind::Identifier
        && expression.as_identifier().text() == "Bun"
        && resolve_lexical_binding(expression).is_none()
}
