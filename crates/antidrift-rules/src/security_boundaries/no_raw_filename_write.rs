use antidrift_kernel::local_binding::{
    Binding, enclosing_variable_declaration, resolve_lexical_binding,
};
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use antidrift_kernel::tsrs_kernel::{cooked_text, unwrap_expression};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub const RULE_NAME: &str = "antidrift/no-raw-filename-write";

pub static DEFAULT_RULE: RuleSpec = RuleSpec::new(RULE_NAME, LISTENERS, visit);

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::PropertyAssignment),
    Listener::Enter(Kind::ShorthandPropertyAssignment),
];

fn visit(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
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

fn static_key_name(key: P<Node>) -> Option<&'static str> {
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => cooked_text(key),
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
