use antidrift_kernel::imports::FileImports;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{collect_return_expressions, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-stable-snapshot";
const HOOK_NAME: &str = "useSyncExternalStore";
const SNAPSHOT_ARGUMENT_INDICES: [usize; 2] = [1, 2];
const FRESH_STATIC_CALLS: [(&str, &str); 2] = [("Object", "assign"), ("Array", "from")];
const FRESH_MEMBER_METHODS: [&str; 6] = ["map", "filter", "slice", "concat", "flat", "flatMap"];
const MESSAGE: &str = "getSnapshot/getServerSnapshot must return a cached reference, not a fresh object/array/derived collection each call. React compares results with Object.is, so an unstable snapshot trips 'The result of getSnapshot should be cached' and can loop into 'Maximum update depth exceeded'. Cache the snapshot in the store and return the same reference until the underlying data changes.";

pub struct RequireStableSnapshot {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireStableSnapshot = RequireStableSnapshot {
    scope: RuleScope::DEFAULT,
};

impl RequireStableSnapshot {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireStableSnapshot {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(Visitor {
                aliases: FxHashSet::default(),
                namespaces: FxHashSet::default(),
            });
        }
        let imports = FileImports::collect(ctx.file);
        Box::new(Visitor {
            aliases: imports.locals_from("react", &[HOOK_NAME]),
            namespaces: imports.namespaces_from("react"),
        })
    }
}

struct Visitor {
    aliases: FxHashSet<&'static str>,
    namespaces: FxHashSet<&'static str>,
}

impl Visitor {
    fn is_hook_call(&self, call_node: P<Node>) -> bool {
        let callee = call_node.as_call_expression().expression();
        match callee.kind() {
            Kind::Identifier => self.aliases.contains(callee.as_identifier().text()),
            Kind::PropertyAccessExpression => {
                let access = callee.as_property_access_expression();
                let prop = access.name();
                let obj = access.expression();
                ast::is_identifier(prop)
                    && prop.as_identifier().text() == HOOK_NAME
                    && ast::is_identifier(obj)
                    && self.namespaces.contains(obj.as_identifier().text())
            }
            _ => false,
        }
    }
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.aliases.is_empty() && self.namespaces.is_empty() {
            &[]
        } else {
            LISTENERS
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if !self.is_hook_call(node) {
            return;
        }
        let args = node.as_call_expression().arguments().nodes();
        let unstable = SNAPSHOT_ARGUMENT_INDICES
            .iter()
            .filter_map(|&index| args.get(index).copied())
            .any(snapshot_returns_fresh_reference);
        if unstable {
            ctx.report_node(node, RuleMessage::new("requireStableSnapshot", MESSAGE));
        }
    }
}

fn is_fresh_reference_call(call_node: P<Node>) -> bool {
    let callee = call_node.as_call_expression().expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = callee.as_property_access_expression();
    let prop = access.name();
    if !ast::is_identifier(prop) {
        return false;
    }
    let method = prop.as_identifier().text();
    let obj = access.expression();
    let is_static_fresh = ast::is_identifier(obj)
        && FRESH_STATIC_CALLS
            .iter()
            .any(|(owner, name)| obj.as_identifier().text() == *owner && method == *name);
    is_static_fresh || FRESH_MEMBER_METHODS.contains(&method)
}

fn is_fresh_reference(expression: P<Node>) -> bool {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::ObjectLiteralExpression | Kind::ArrayLiteralExpression => true,
        Kind::CallExpression => is_fresh_reference_call(inner),
        _ => false,
    }
}

fn snapshot_returns_fresh_reference(argument: P<Node>) -> bool {
    if !matches!(
        argument.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) {
        return false;
    }
    collect_return_expressions(argument.body())
        .into_iter()
        .any(is_fresh_reference)
}
