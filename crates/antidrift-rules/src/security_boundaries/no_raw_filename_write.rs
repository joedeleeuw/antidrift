use antidrift_kernel::local_binding::{
    Binding, enclosing_variable_declaration, resolve_lexical_binding,
};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::unwrap_expression;
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-raw-filename-write";

pub struct NoRawFilenameWrite {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoRawFilenameWrite = NoRawFilenameWrite {
    scope: RuleScope::DEFAULT,
};

impl NoRawFilenameWrite {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::PropertyAssignment),
    Listener::Enter(Kind::ShorthandPropertyAssignment),
];

impl Rule for NoRawFilenameWrite {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        Box::new(Visitor { enabled })
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
        let (key, value) = match node.kind() {
            Kind::PropertyAssignment => {
                let assign = node.as_property_assignment();
                (assign.name(), assign.initializer())
            }
            Kind::ShorthandPropertyAssignment => {
                let short = node.as_shorthand_property_assignment();
                (short.name(), short.name())
            }
            _ => return,
        };
        if static_key_name(key) == Some("fileName") && raw_filename(value, &FxHashSet::default()) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "rawFilename",
                    "Use sanitizeFilename() before assigning to fileName. Raw strings may contain path traversal segments.",
                ),
            );
        }
    }
}

fn static_key_name(key: P<Node>) -> Option<&'static str> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => Some(key.as_string_literal().text()),
        _ => None,
    }
}

fn raw_filename(expression: P<Node>, seen: &FxHashSet<Binding>) -> bool {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::PropertyAccessExpression => raw_member(inner),
        Kind::TemplateExpression => inner
            .as_template_expression()
            .template_spans()
            .nodes()
            .iter()
            .any(|&span| raw_filename(span.as_template_span().expression(), seen)),
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            raw_filename(bin.left(), seen) || raw_filename(bin.right(), seen)
        }
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            raw_filename(cond.when_true(), seen) || raw_filename(cond.when_false(), seen)
        }
        Kind::Identifier => raw_binding(inner, seen),
        _ => false,
    }
}

fn raw_member(member_node: P<Node>) -> bool {
    let member = member_node.as_property_access_expression();
    let obj = member.expression();
    let prop = member.name();
    ast::is_identifier(obj)
        && raw_input(obj.as_identifier().text())
        && ast::is_identifier(prop)
        && raw_property(prop.as_identifier().text())
}

fn raw_binding(identifier: P<Node>, seen: &FxHashSet<Binding>) -> bool {
    let Some(binding) = resolve_lexical_binding(identifier) else {
        return false;
    };
    let mut visited = seen.clone();
    if !visited.insert(binding) {
        return false;
    }
    match binding.decl.kind() {
        Kind::BindingElement => raw_destructuring(binding),
        Kind::VariableDeclaration => binding
            .decl
            .as_variable_declaration()
            .initializer()
            .is_some_and(|init| raw_filename(init, &visited)),
        _ => false,
    }
}

fn raw_destructuring(binding: Binding) -> bool {
    let elem = binding.decl.as_binding_element();
    let Some(bound_name) = binding.decl.name() else {
        return false;
    };
    if !ast::is_identifier(bound_name) || bound_name.as_identifier().text() != binding.name() {
        return false;
    }
    let key_node = elem.property_name().unwrap_or(bound_name);
    let Some(key_name) = static_key_name(key_node) else {
        return false;
    };
    if !raw_property(key_name) {
        return false;
    }
    let Some(var_decl) = enclosing_variable_declaration(binding) else {
        return false;
    };
    let Some(init) = var_decl.as_variable_declaration().initializer() else {
        return false;
    };
    let inner_init = unwrap_expression(init);
    ast::is_identifier(inner_init) && raw_input(inner_init.as_identifier().text())
}

fn raw_input(name: &str) -> bool {
    matches!(name, "file" | "body" | "query" | "part")
}

fn raw_property(name: &str) -> bool {
    matches!(name, "name" | "filename" | "fileName")
}
