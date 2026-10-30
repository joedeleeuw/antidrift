use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-authz-check";

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct AuthzOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    authz_functions: Vec<String>,
}

pub struct RequireAuthzCheck {
    scope: RuleScope,
    authz_functions: Vec<String>,
}

pub static DEFAULT_RULE: RequireAuthzCheck = RequireAuthzCheck {
    scope: RuleScope::DEFAULT,
    authz_functions: Vec::new(),
};

impl RequireAuthzCheck {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<AuthzOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        if parsed.authz_functions.iter().any(String::is_empty) {
            return Err("authzFunctions must contain non-empty strings".to_owned());
        }
        Ok(Self {
            scope,
            authz_functions: parsed.authz_functions,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Exit(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
    Listener::Exit(Kind::FunctionExpression),
    Listener::Enter(Kind::ArrowFunction),
    Listener::Exit(Kind::ArrowFunction),
    Listener::Enter(Kind::MethodDeclaration),
    Listener::Exit(Kind::MethodDeclaration),
    Listener::Enter(Kind::Constructor),
    Listener::Exit(Kind::Constructor),
    Listener::Enter(Kind::GetAccessor),
    Listener::Exit(Kind::GetAccessor),
    Listener::Enter(Kind::SetAccessor),
    Listener::Exit(Kind::SetAccessor),
    Listener::Enter(Kind::PropertyAccessExpression),
    Listener::Enter(Kind::ElementAccessExpression),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for RequireAuthzCheck {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            functions: &self.authz_functions,
            frames: Vec::new(),
        })
    }
}

#[derive(Default)]
struct AuthorizationFrame {
    params_access: Option<P<Node>>,
    saw_authz: bool,
}

struct Visitor {
    functions: &'static [String],
    frames: Vec<AuthorizationFrame>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.functions.is_empty() {
            &[]
        } else {
            LISTENERS
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, listener: Listener, node: P<Node>) {
        match listener {
            Listener::Enter(
                Kind::FunctionDeclaration
                | Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::MethodDeclaration
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                self.frames.push(AuthorizationFrame::default());
            }
            Listener::Exit(
                Kind::FunctionDeclaration
                | Kind::FunctionExpression
                | Kind::ArrowFunction
                | Kind::MethodDeclaration
                | Kind::Constructor
                | Kind::GetAccessor
                | Kind::SetAccessor,
            ) => {
                if let Some(frame) = self.frames.pop()
                    && !frame.saw_authz
                    && let Some(access_node) = frame.params_access
                {
                    ctx.report_node(
                        access_node,
                        RuleMessage::new(
                            "missingAuthz",
                            "Handler reads request params without a configured authorization/ownership check.",
                        ),
                    );
                }
            }
            Listener::Enter(Kind::PropertyAccessExpression | Kind::ElementAccessExpression) => {
                self.record_params_access(node);
            }
            Listener::Enter(Kind::CallExpression) => {
                self.record_authz_call(node);
            }
            _ => {}
        }
    }
}

impl Visitor {
    fn record_params_access(&mut self, node: P<Node>) {
        let Some(frame) = self.frames.last_mut() else {
            return;
        };
        let Some(member_name) = member_identifier(node) else {
            return;
        };
        let Some(raw_obj) = antidrift_kernel::tsrs_kernel::member_object(node) else {
            return;
        };
        let obj = ast::skip_parentheses(raw_obj);
        if !ast::is_identifier(obj) {
            return;
        }
        let obj_name = obj.as_identifier().text();
        let is_req_params = member_name == "params"
            && ["req", "request", "ctx", "context", "event"].contains(&obj_name);
        let is_direct_params = obj_name == "params" && !member_name.is_empty();
        if is_req_params || is_direct_params {
            frame.params_access.get_or_insert(node);
        }
    }

    fn record_authz_call(&mut self, node: P<Node>) {
        let callee = ast::skip_parentheses(node.as_call_expression().expression());
        let name = if ast::is_identifier(callee) {
            Some(callee.as_identifier().text())
        } else {
            member_identifier(callee)
        };
        if let Some(frame) = self.frames.last_mut()
            && name.is_some_and(|name| self.functions.iter().any(|function| function == name))
        {
            frame.saw_authz = true;
        }
    }
}

fn member_identifier(node: P<Node>) -> Option<&'static str> {
    match node.kind() {
        Kind::PropertyAccessExpression => {
            let prop = node.as_property_access_expression().name();
            ast::is_identifier(prop).then(|| prop.as_identifier().text())
        }
        Kind::ElementAccessExpression => {
            let arg =
                ast::skip_parentheses(node.as_element_access_expression().argument_expression());
            if ast::is_identifier(arg) {
                Some(arg.as_identifier().text())
            } else if ast::is_string_literal(arg) {
                cooked_text(arg)
            } else {
                None
            }
        }
        _ => None,
    }
}
