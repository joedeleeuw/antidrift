use antidrift_kernel::jsx::attribute_name;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use antidrift_kernel::tsrs_kernel::{cooked_text, is_function_like, unwrap_expression};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-duplicated-conditional-classnames";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct ClassnameOptions {
    attributes: Vec<String>,
    helpers: Vec<String>,
    min_shared_ratio: f64,
    min_shared_tokens: usize,
    #[serde(flatten)]
    scope: ScopeOptions,
}

impl Default for ClassnameOptions {
    fn default() -> Self {
        Self {
            attributes: vec!["class".to_owned(), "className".to_owned()],
            helpers: Vec::new(),
            min_shared_ratio: 0.65,
            min_shared_tokens: 4,
            scope: ScopeOptions::default(),
        }
    }
}

fn require_unique_names(field: &str, names: &[String]) -> Result<(), String> {
    if names.iter().any(String::is_empty) {
        return Err(format!(
            "invalid options for {RULE_NAME}: '{field}' must be an array of non-empty strings"
        ));
    }
    let unique: FxHashSet<&str> = names.iter().map(String::as_str).collect();
    if unique.len() != names.len() {
        return Err(format!(
            "invalid options for {RULE_NAME}: '{field}' must not contain duplicate entries"
        ));
    }
    Ok(())
}

impl ClassnameOptions {
    fn decode(raw: Option<&serde_json::Value>) -> Result<Self, String> {
        let options = decode_rule_options::<Self>(RULE_NAME, raw)?;
        require_unique_names("attributes", &options.attributes)?;
        require_unique_names("helpers", &options.helpers)?;
        if !(0.0..=1.0).contains(&options.min_shared_ratio) {
            return Err(format!(
                "invalid options for {RULE_NAME}: 'minSharedRatio' must be between 0 and 1"
            ));
        }
        if options.min_shared_tokens < 1 {
            return Err(format!(
                "invalid options for {RULE_NAME}: 'minSharedTokens' must be an integer greater than or equal to 1"
            ));
        }
        Ok(options)
    }
}

pub struct NoDuplicatedConditionalClassnames {
    options: ClassnameOptions,
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoDuplicatedConditionalClassnames = NoDuplicatedConditionalClassnames {
    options: ClassnameOptions {
        attributes: Vec::new(),
        helpers: Vec::new(),
        min_shared_ratio: 0.65,
        min_shared_tokens: 4,
        scope: ScopeOptions {
            files: None,
            exclude_files: Vec::new(),
        },
    },
    scope: RuleScope::DEFAULT,
};

impl NoDuplicatedConditionalClassnames {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = ClassnameOptions::decode(options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &decoded.scope)?;
        Ok(Self {
            options: decoded,
            scope,
        })
    }

    fn matches_attribute(&self, name: &str) -> bool {
        if self.options.attributes.is_empty() {
            matches!(name, "class" | "className")
        } else {
            self.options.attributes.iter().any(|attr| attr == name)
        }
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::ConditionalExpression)];

impl Rule for NoDuplicatedConditionalClassnames {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static NoDuplicatedConditionalClassnames,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if !is_class_string_context(node, self.rule) {
            return;
        }
        let cond = node.as_conditional_expression();
        let (Some(left), Some(right)) = (
            static_string(cond.when_true()),
            static_string(cond.when_false()),
        ) else {
            return;
        };
        if let Some(message) = overlap_message(left, right, &self.rule.options) {
            ctx.report_node(
                node,
                RuleMessage::new("duplicatedConditionalClassnames", message),
            );
        }
    }
}

fn is_class_string_context(node: P<Node>, rule: &NoDuplicatedConditionalClassnames) -> bool {
    is_within_class_attribute(node, rule) || is_class_helper_argument(node, &rule.options)
}

fn is_within_class_attribute(node: P<Node>, rule: &NoDuplicatedConditionalClassnames) -> bool {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if ancestor.kind() == Kind::JsxExpression
            && ancestor
                .parent()
                .and_then(attribute_name)
                .is_some_and(|name| rule.matches_attribute(name))
        {
            return true;
        }
        if is_function_like(ancestor) {
            return false;
        }
        cursor = ancestor.parent();
    }
    false
}

fn class_value_wrapper(node: P<Node>) -> Option<P<Node>> {
    let parent = node.parent()?;
    match parent.kind() {
        Kind::ArrayLiteralExpression | Kind::SpreadElement | Kind::ParenthesizedExpression => {
            Some(parent)
        }
        Kind::PropertyAssignment => {
            let assign = parent.as_property_assignment();
            let key = assign.name();
            let matches_child = assign.initializer() == node
                || (key.kind() == Kind::ComputedPropertyName
                    && key.as_computed_property_name().expression() == node);
            if !matches_child {
                return None;
            }
            let grandparent = parent.parent()?;
            (grandparent.kind() == Kind::ObjectLiteralExpression).then_some(grandparent)
        }
        _ => None,
    }
}

fn callee_name(callee: P<Node>) -> &'static str {
    match callee.kind() {
        Kind::Identifier => callee.as_identifier().text(),
        Kind::PropertyAccessExpression => {
            let prop = callee.as_property_access_expression().name();
            if ast::is_identifier(prop) {
                prop.as_identifier().text()
            } else {
                ""
            }
        }
        Kind::ElementAccessExpression => {
            let arg = callee.as_element_access_expression().argument_expression();
            if arg.kind() == Kind::StringLiteral
                && let Some(name) = cooked_text(arg)
            {
                name
            } else {
                ""
            }
        }
        _ => "",
    }
}

fn is_class_helper_argument(node: P<Node>, options: &ClassnameOptions) -> bool {
    let mut current = node;
    while let Some(wrapper) = class_value_wrapper(current) {
        current = wrapper;
    }
    let Some(parent) = current.parent() else {
        return false;
    };
    if parent.kind() != Kind::CallExpression {
        return false;
    }
    let call = parent.as_call_expression();
    call.arguments().nodes().contains(&current)
        && options
            .helpers
            .iter()
            .any(|helper| helper == callee_name(call.expression()))
}

fn static_string(expression: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral => cooked_text(inner),
        _ => None,
    }
}

fn unique_tokens(value: &str) -> Vec<&str> {
    let mut seen = FxHashSet::default();
    value
        .split_whitespace()
        .filter(|token| seen.insert(*token))
        .collect()
}

fn overlap_message(left: &str, right: &str, options: &ClassnameOptions) -> Option<String> {
    let left_tokens = unique_tokens(left);
    let right_tokens = unique_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return None;
    }
    let right_set: FxHashSet<&str> = right_tokens.iter().copied().collect();
    let shared: Vec<&str> = left_tokens
        .iter()
        .copied()
        .filter(|token| right_set.contains(token))
        .collect();
    let longest = left_tokens.len().max(right_tokens.len());
    if longest == shared.len() || shared.len() < options.min_shared_tokens {
        return None;
    }
    let shortest = left_tokens.len().min(right_tokens.len());
    if (shared.len() as f64) / (shortest as f64) < options.min_shared_ratio {
        return None;
    }
    let preview = shared.iter().take(8).copied().collect::<Vec<_>>().join(" ");
    Some(format!(
        "Conditional class strings share {} class tokens ({preview}). Hoist the shared class list and keep only the differing tokens conditional.",
        shared.len()
    ))
}
