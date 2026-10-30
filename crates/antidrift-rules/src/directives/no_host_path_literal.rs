use antidrift_kernel::file_role::{ProjectPath, is_test_file};
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, in_scope};
use tsrs_ast::{Kind, Node};
use tsrs_core::{P, tspath};
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-host-path-literal";

pub struct NoHostPathLiteral {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoHostPathLiteral = NoHostPathLiteral {
    scope: RuleScope::DEFAULT,
};

impl NoHostPathLiteral {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::StringLiteral),
    Listener::Enter(Kind::NoSubstitutionTemplateLiteral),
];

struct Visitor;

impl Rule for NoHostPathLiteral {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, Some(is_non_exempt_host_path_file)) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let text = match node.kind() {
            Kind::StringLiteral => node.as_string_literal().text(),
            Kind::NoSubstitutionTemplateLiteral => node.text(),
            _ => return,
        };
        if is_host_path_literal(text) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "hostPathLiteral",
                    "Host-absolute path literal. Resolve the path from the home directory, the repository root, or configuration.",
                ),
            );
        }
    }
}

fn is_non_exempt_host_path_file(path: &ProjectPath) -> bool {
    if is_test_file(path) {
        return false;
    }
    let normalized = path.as_str();
    if normalized
        .split('/')
        .any(|segment| matches!(segment, "example" | "examples" | "e2e"))
    {
        return false;
    }
    let stem = tspath::remove_file_extension(normalized);
    !stem.ends_with(".stories")
}

fn is_host_path_literal(text: &str) -> bool {
    let rest = text
        .strip_prefix("/Users/")
        .or_else(|| text.strip_prefix("/home/"));
    let Some(after_root) = rest else {
        return false;
    };
    let Some((user_segment, _)) = after_root.split_once('/') else {
        return false;
    };
    !user_segment.is_empty() && user_segment != "linuxbrew"
}
