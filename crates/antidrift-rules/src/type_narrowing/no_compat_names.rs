use antidrift_kernel::declared_names::{DeclaredNameIndex, is_compat_name, plain_sibling_key};
use antidrift_kernel::program_fact::ProgramFact;
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const RULE_NAME: &str = "antidrift/no-compat-names";

#[must_use]
pub fn compat_message(name: &str, sibling: Option<&str>) -> RuleMessage {
    let text = match sibling {
        Some(sibling) => format!(
            "'{name}' uses compatibility naming while '{sibling}' is also declared. Delete the old path instead of keeping or naming it."
        ),
        None => format!(
            "'{name}' uses compatibility naming. Delete the old path instead of keeping or naming it."
        ),
    };
    RuleMessage::new("compatName", text)
}

pub struct NoCompatNames;

impl NoCompatNames {
    pub const DEFAULT: Self = Self;
}

pub static DEFAULT_INSTANCE: NoCompatNames = NoCompatNames::DEFAULT;

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
    Listener::Enter(Kind::VariableDeclaration),
    Listener::Enter(Kind::ClassDeclaration),
    Listener::Enter(Kind::InterfaceDeclaration),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Enter(Kind::PropertyDeclaration),
    Listener::Enter(Kind::PropertySignature),
    Listener::Enter(Kind::EndOfFile),
];

impl Rule for NoCompatNames {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor::default())
    }
}

#[derive(Default)]
struct Visitor {
    pending: Vec<(P<Node>, Option<String>)>,
}

impl Visitor {
    fn check_ident(&mut self, node: Option<P<Node>>) {
        let Some(ident) = node else {
            return;
        };
        if !ast::is_identifier(ident) {
            return;
        }
        let text = ident.as_identifier().text();
        if is_compat_name(text) {
            self.pending.push((ident, plain_sibling_key(text)));
        }
    }

    fn check_binding_node(&mut self, node: Option<P<Node>>) {
        let Some(curr) = node else {
            return;
        };
        match curr.kind() {
            Kind::Identifier => self.check_ident(Some(curr)),
            Kind::Parameter | Kind::BindingElement => self.check_binding_node(curr.name()),
            Kind::ObjectBindingPattern | Kind::ArrayBindingPattern => {
                for &elem in curr.as_binding_pattern().elements().nodes() {
                    self.check_binding_node(Some(elem));
                }
            }
            _ => {}
        }
    }

    fn check_parameters(&mut self, node: P<Node>) {
        for &param in node.parameters() {
            self.check_binding_node(Some(param));
        }
    }

    fn report_pending(&mut self, ctx: &mut Ctx) {
        if self.pending.is_empty() {
            return;
        }
        let index = DeclaredNameIndex::for_program(ctx.program);
        for (ident, sibling_key) in std::mem::take(&mut self.pending) {
            let sibling = sibling_key
                .as_deref()
                .and_then(|key| index.declared_with_key(key));
            let name = ident.as_identifier().text();
            ctx.report_node(ident, compat_message(name, sibling));
        }
    }
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(Kind::FunctionDeclaration | Kind::MethodDeclaration) => {
                self.check_ident(node.name());
                self.check_parameters(node);
            }
            Listener::Enter(
                Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                self.check_parameters(node);
            }
            Listener::Enter(Kind::VariableDeclaration) => {
                self.check_binding_node(node.name());
            }
            Listener::Enter(
                Kind::ClassDeclaration
                | Kind::InterfaceDeclaration
                | Kind::TypeAliasDeclaration
                | Kind::PropertyDeclaration
                | Kind::PropertySignature,
            ) => {
                self.check_ident(node.name());
            }
            Listener::Enter(Kind::EndOfFile) => self.report_pending(ctx),
            _ => {}
        }
    }
}
