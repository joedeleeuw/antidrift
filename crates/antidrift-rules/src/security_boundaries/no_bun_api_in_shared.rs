use antidrift_kernel::file_role::FileRole;
use antidrift_kernel::file_role::ProjectPath;
use antidrift_kernel::local_binding::resolve_lexical_binding;
use antidrift_kernel::rule_options::reject_unknown_options;
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-bun-api-in-shared";

pub struct NoBunApiInShared;

pub static DEFAULT_RULE: NoBunApiInShared = NoBunApiInShared;

impl NoBunApiInShared {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        reject_unknown_options(RULE_NAME, options)?;
        Ok(Self)
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::PropertyAccessExpression),
    Listener::Enter(Kind::ElementAccessExpression),
];

#[must_use]
pub fn inferred_role(path: &ProjectPath) -> bool {
    path.has_role(FileRole::Shared)
}

impl Rule for NoBunApiInShared {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
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

fn unbound_bun(expression: P<Node>) -> bool {
    expression.kind() == Kind::Identifier
        && expression.as_identifier().text() == "Bun"
        && resolve_lexical_binding(expression).is_none()
}
