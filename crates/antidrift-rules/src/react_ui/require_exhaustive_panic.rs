use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use antidrift_kernel::tsrs_kernel::unwrap_parentheses;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub const RULE_NAME: &str = "antidrift/require-exhaustive-panic";
const MESSAGE: &str = "Terminate this unreachable branch with a throw or the configured exhaustive-failure owner; a never annotation has no runtime effect.";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct ExhaustivePanicOptions {
    failure_functions: Vec<String>,
}

pub struct RequireExhaustivePanic {
    failure_functions: Vec<String>,
}

pub static DEFAULT_RULE: RequireExhaustivePanic = RequireExhaustivePanic {
    failure_functions: Vec::new(),
};

impl crate::ConfigurableRule for RequireExhaustivePanic {
    type Options = ExhaustivePanicOptions;

    fn from_options(parsed: Self::Options) -> Result<Self, String> {
        Ok(Self {
            failure_functions: parsed.failure_functions,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::VariableDeclaration)];

impl Rule for RequireExhaustivePanic {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static RequireExhaustivePanic,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let is_never = node
            .as_variable_declaration()
            .type_()
            .is_some_and(|annotation| annotation.kind() == Kind::NeverKeyword);
        if !is_never {
            return;
        }
        let Some(var_stmt) = node.parent().and_then(|list| list.parent()) else {
            return;
        };
        if var_stmt.kind() != Kind::VariableStatement {
            return;
        }
        let Some(statements) = sibling_statements(var_stmt) else {
            return;
        };
        if !terminates(statements, var_stmt, &self.rule.failure_functions) {
            ctx.report_node(node, RuleMessage::new("exhaustive", MESSAGE));
        }
    }
}

fn sibling_statements(var_stmt: P<Node>) -> Option<&'static [P<Node>]> {
    let parent = var_stmt.parent()?;
    match parent.kind() {
        Kind::SourceFile => Some(parent.as_source_file().statements().nodes()),
        Kind::Block => Some(parent.as_block().statements().nodes()),
        Kind::CaseClause | Kind::DefaultClause => {
            Some(parent.as_case_or_default_clause().statements().nodes())
        }
        Kind::ClassStaticBlockDeclaration => Some(
            parent
                .as_class_static_block_declaration()
                .body()
                .as_block()
                .statements()
                .nodes(),
        ),
        Kind::ModuleBlock => Some(parent.as_module_block().statements().nodes()),
        _ => None,
    }
}

fn calls_failure(statement: P<Node>, failures: &[String]) -> bool {
    let expression = match statement.kind() {
        Kind::ReturnStatement => statement.as_return_statement().expression(),
        Kind::ExpressionStatement => Some(statement.as_expression_statement().expression()),
        _ => None,
    };
    let Some(inner) = expression.map(unwrap_parentheses) else {
        return false;
    };
    if inner.kind() != Kind::CallExpression {
        return false;
    }
    let callee = inner.as_call_expression().expression();
    ast::is_identifier(callee)
        && failures
            .iter()
            .any(|name| name == callee.as_identifier().text())
}

fn terminates(statements: &[P<Node>], declaration: P<Node>, failures: &[String]) -> bool {
    statements
        .iter()
        .copied()
        .skip_while(|&statement| statement != declaration)
        .skip(1)
        .any(|statement| {
            statement.kind() == Kind::ThrowStatement || calls_failure(statement, failures)
        })
}
