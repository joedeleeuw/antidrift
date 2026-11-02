use super::syntax::{
    cooked_text, enclosing_variable_declaration, global, identifier_member, is_function_like,
    is_var_variable_declaration, member, resolve_lexical_binding, unwrap_expression,
    unwrap_parentheses,
};
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleSpec, RuleVisitor};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node};
use tsrs_core::P;

const CALL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];
const SINGLETON_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::NewExpression),
];

const DEFAULT_CONSTRUCTORS: &[&str] = &["RedisClient", "Queue", "Worker", "S3Client", "SQL"];
const DEFAULT_FACTORIES: &[&str] = &["createRedisClient", "postgres"];

pub static NO_ASYNC_CONTEXT_ENTER_WITH: RuleSpec = RuleSpec::new(
    "antidrift/no-async-context-enter-with",
    CALL_LISTENERS,
    visit_async_context_enter_with,
);

pub static REQUIRE_FUNCTION_REPLACER: RuleSpec = RuleSpec::new(
    "antidrift/require-function-replacer",
    CALL_LISTENERS,
    visit_function_replacer,
);

fn visit_async_context_enter_with(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let callee = node.as_call_expression().expression();
    if callee.kind() == Kind::PropertyAccessExpression {
        let name = callee.as_property_access_expression().name();
        if ast::is_identifier(name) && name.as_identifier().text() == "enterWith" {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "noEnterWith",
                    "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient async context frame with no restore point, so background work that resumes there adopts the store. Scope it with run(...) at the boundary instead (see request-scope.ts).",
                ),
            );
            return;
        }
    }
    if is_app_exit_in_signal_handler(node) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "noAppExitInSignalHandler",
                "Do not call app.exit() inside a SIGTERM/SIGINT signal handler; it bypasses Electron before-quit and will-quit cleanup. Call app.quit() instead.",
            ),
        );
    } else if is_unguarded_sync_fs_in_logger(node) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "unguardedSyncFsInLogger",
                "Do not call appendFileSync/writeFileSync unguarded inside a logger writer or sink; wrap the sync filesystem write in a try/catch so a full disk or EIO error during logging cannot crash the process or block shutdown.",
            ),
        );
    }
}

fn is_signal_handler_registration(call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let Some((recv, "on" | "once" | "addListener")) = member(call.expression()) else {
        return false;
    };
    if !ast::is_identifier(recv) || recv.as_identifier().text() != "process" {
        return false;
    }
    call.arguments()
        .nodes()
        .first()
        .map(|&arg| unwrap_expression(arg))
        .filter(|arg| {
            matches!(
                arg.kind(),
                Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
            )
        })
        .and_then(cooked_text)
        .is_some_and(|sig| matches!(sig, "SIGTERM" | "SIGINT" | "SIGHUP"))
}

fn is_app_exit_in_signal_handler(node: P<Node>) -> bool {
    let Some((recv, "exit")) = member(node.as_call_expression().expression()) else {
        return false;
    };
    if !ast::is_identifier(recv) || recv.as_identifier().text() != "app" {
        return false;
    }
    let mut curr = node.parent();
    while let Some(anc) = curr {
        if anc.kind() == Kind::CallExpression && is_signal_handler_registration(anc) {
            return true;
        }
        curr = anc.parent();
    }
    false
}

fn is_unguarded_sync_fs_in_logger(node: P<Node>) -> bool {
    let callee = unwrap_expression(node.as_call_expression().expression());
    let is_sync_write = match callee.kind() {
        Kind::Identifier => matches!(
            callee.as_identifier().text(),
            "appendFileSync" | "writeFileSync"
        ),
        _ => member(callee).is_some_and(|(_, m)| matches!(m, "appendFileSync" | "writeFileSync")),
    };
    if !is_sync_write {
        return false;
    }
    let mut curr = node.parent();
    let mut saw_fn = false;
    while let Some(anc) = curr {
        if !saw_fn && anc.kind() == Kind::TryStatement {
            return false;
        }
        if is_function_like(anc) {
            saw_fn = true;
        }
        if saw_fn && is_logger_owner_node(anc) {
            return true;
        }
        curr = anc.parent();
    }
    false
}

fn is_logger_owner_node(anc: P<Node>) -> bool {
    let name = match anc.kind() {
        Kind::VariableDeclaration | Kind::FunctionDeclaration | Kind::PropertyAssignment => anc
            .name()
            .filter(|&n| ast::is_identifier(n))
            .map(|n| n.as_identifier().text()),
        Kind::CallExpression => {
            let expr = unwrap_expression(anc.as_call_expression().expression());
            if ast::is_identifier(expr) {
                Some(expr.as_identifier().text())
            } else {
                member(expr).map(|(_, m)| m)
            }
        }
        _ => None,
    };
    name.is_some_and(|n| {
        let lower = n.to_lowercase();
        lower.contains("log") || lower.contains("sink") || lower.contains("transport")
    })
}

fn visit_function_replacer(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let call = node.as_call_expression();
    let callee = call.expression();
    let method = member(callee).or_else(|| identifier_member(unwrap_expression(callee)));
    let Some((_, method @ ("replace" | "replaceAll"))) = method else {
        return;
    };
    let args = call.arguments().nodes();
    if args.len() != 2
        || args[0].kind() == Kind::SpreadElement
        || args[1].kind() == Kind::SpreadElement
    {
        return;
    }
    let replacement = args[1];
    if allowed_replacer(unwrap_expression(replacement)) {
        return;
    }
    ctx.report_node(
        unwrap_parentheses(replacement),
        RuleMessage::new(
            "requireFunctionReplacer",
            format!(
                "Dynamic value passed as the replacement argument of '.{method}()'. JS interprets '$&', '$$', \"$`\", \"$'\", and '$<name>' in replacement strings even for a plain-string search, so dynamic content can silently corrupt the output. Wrap the replacement in a function: .{method}(pattern, () => value)."
            ),
        ),
    );
}

fn allowed_replacer(expression: P<Node>) -> bool {
    match expression.kind() {
        Kind::ArrowFunction
        | Kind::FunctionExpression
        | Kind::StringLiteral
        | Kind::ObjectLiteralExpression
        | Kind::NoSubstitutionTemplateLiteral => true,
        Kind::TaggedTemplateExpression => {
            let tagged = expression.as_tagged_template_expression();
            member(tagged.tag())
                .is_some_and(|(object, name)| name == "raw" && global(object, "String"))
                && tagged.template().kind() == Kind::NoSubstitutionTemplateLiteral
        }
        Kind::Identifier => {
            let Some(binding) = resolve_lexical_binding(expression) else {
                return false;
            };
            if binding.decl.kind() == Kind::FunctionDeclaration {
                return true;
            }
            enclosing_variable_declaration(binding).is_some_and(|decl| {
                !is_var_variable_declaration(decl)
                    && decl
                        .as_variable_declaration()
                        .initializer()
                        .is_some_and(|init| {
                            matches!(
                                unwrap_expression(init).kind(),
                                Kind::ArrowFunction | Kind::FunctionExpression
                            )
                        })
            })
        }
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct SingletonOptions {
    constructors: Vec<String>,
    factories: Vec<String>,
}

impl Default for SingletonOptions {
    fn default() -> Self {
        Self {
            constructors: DEFAULT_CONSTRUCTORS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            factories: DEFAULT_FACTORIES.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

pub struct NoEagerSingleton {
    constructors: Option<Vec<String>>,
    factories: Option<Vec<String>>,
}

pub static NO_EAGER_SINGLETON: NoEagerSingleton = NoEagerSingleton {
    constructors: None,
    factories: None,
};

impl crate::ConfigurableRule for NoEagerSingleton {
    type Options = SingletonOptions;

    fn from_options(decoded: Self::Options) -> Result<Self, String> {
        Ok(Self {
            constructors: Some(decoded.constructors),
            factories: Some(decoded.factories),
        })
    }
}

impl NoEagerSingleton {
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

impl Rule for NoEagerSingleton {
    fn name(&self) -> &'static str {
        "antidrift/no-eager-singleton"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(SingletonVisitor { rule: self })
    }
}

struct SingletonVisitor {
    rule: &'static NoEagerSingleton,
}

impl RuleVisitor for SingletonVisitor {
    fn listeners(&self) -> &[Listener] {
        SINGLETON_LISTENERS
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
