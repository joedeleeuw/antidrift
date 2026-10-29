use super::syntax::{
    enclosing_variable_declaration, global, identifier_member, is_var_variable_declaration, member,
    resolve_lexical_binding, unwrap_expression, unwrap_parentheses,
};
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-function-replacer";

pub struct RequireFunctionReplacer {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireFunctionReplacer = RequireFunctionReplacer {
    scope: RuleScope::DEFAULT,
};

impl RequireFunctionReplacer {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireFunctionReplacer {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: self.scope.in_scope(ctx),
        })
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
        if allowed(unwrap_expression(replacement)) {
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
}

fn allowed(expression: P<Node>) -> bool {
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
