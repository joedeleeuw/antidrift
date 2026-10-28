use antidrift_kernel::imports::FileImports;
use antidrift_kernel::rule_scope::RuleScope;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-effect-deps";
const EFFECT_HOOKS: [&str; 2] = ["useEffect", "useLayoutEffect"];

pub struct RequireEffectDeps {
    _scope: RuleScope,
}

pub static DEFAULT_RULE: RequireEffectDeps = RequireEffectDeps {
    _scope: RuleScope::DEFAULT,
};

impl RequireEffectDeps {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            _scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireEffectDeps {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let imports = FileImports::collect(ctx.file);
        let direct = imports.locals_from("react", &EFFECT_HOOKS);
        let namespaces = imports.namespaces_from("react");
        Box::new(Visitor { direct, namespaces })
    }
}

struct Visitor {
    direct: FxHashSet<&'static str>,
    namespaces: FxHashSet<&'static str>,
}

impl Visitor {
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

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.direct.is_empty() && self.namespaces.is_empty() {
            &[]
        } else {
            LISTENERS
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
