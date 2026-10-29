use super::syntax::is_function_like;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-eager-singleton";

const DEFAULT_CONSTRUCTORS: &[&str] = &["RedisClient", "Queue", "Worker", "S3Client", "SQL"];
const DEFAULT_FACTORIES: &[&str] = &["createRedisClient", "postgres"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct SingletonOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    constructors: Vec<String>,
    factories: Vec<String>,
}

impl Default for SingletonOptions {
    fn default() -> Self {
        Self {
            scope: ScopeOptions::default(),
            constructors: DEFAULT_CONSTRUCTORS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            factories: DEFAULT_FACTORIES.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

pub struct NoEagerSingleton {
    scope: RuleScope,
    constructors: Option<Vec<String>>,
    factories: Option<Vec<String>>,
}

pub static DEFAULT_RULE: NoEagerSingleton = NoEagerSingleton {
    scope: RuleScope::DEFAULT,
    constructors: None,
    factories: None,
};

impl NoEagerSingleton {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = decode_rule_options::<SingletonOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &decoded.scope)?;
        Ok(Self {
            scope,
            constructors: Some(decoded.constructors),
            factories: Some(decoded.factories),
        })
    }

    fn has_constructor(&self, name: &str) -> bool {
        match &self.constructors {
            Some(list) => list.iter().any(|entry| entry == name),
            None => DEFAULT_CONSTRUCTORS.contains(&name),
        }
    }

    fn has_factory(&self, name: &str) -> bool {
        match &self.factories {
            Some(list) => list.iter().any(|entry| entry == name),
            None => DEFAULT_FACTORIES.contains(&name),
        }
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::NewExpression),
];

impl Rule for NoEagerSingleton {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            rule: self,
            enabled: self.scope.in_scope(ctx),
        })
    }
}

struct Visitor {
    rule: &'static NoEagerSingleton,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let (callee, is_ctor, prefix) = match node.kind() {
            Kind::CallExpression => (node.as_call_expression().expression(), false, ""),
            Kind::NewExpression => (node.as_new_expression().expression(), true, "new "),
            _ => return,
        };
        if !ast::is_identifier(callee) {
            return;
        }
        let name = callee.as_identifier().text();
        let matched = if is_ctor {
            self.rule.has_constructor(name)
        } else {
            self.rule.has_factory(name)
        };
        if !matched {
            return;
        }
        let mut suppressed = false;
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if is_function_like(ancestor)
                || (ancestor.kind() == Kind::PropertyDeclaration
                    && !ancestor.modifier_flags().intersects(ModifierFlags::Static))
            {
                suppressed = true;
                break;
            }
            cursor = ancestor.parent();
        }
        if !suppressed {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "eagerSingleton",
                    format!(
                        "Construct '{prefix}{name}' in the configured runtime resource owner at startup or first use, rather than module evaluation."
                    ),
                ),
            );
        }
    }
}
