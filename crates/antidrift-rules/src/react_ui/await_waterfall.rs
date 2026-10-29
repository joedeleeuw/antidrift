use antidrift_kernel::jsx::function_returns_jsx;
use antidrift_kernel::local_binding::{Binding, declared_bindings, for_each_resolved_reference};
use antidrift_kernel::tsrs_kernel::{
    callee_name, is_function_like, member_chain_root_identifier, property_name_text,
    static_member_chain, unwrap_expression,
};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const MUTATION_PREFIXES: [&str; 13] = [
    "write", "update", "delete", "remove", "insert", "create", "mutate", "exec", "commit", "push",
    "set", "save", "checkout",
];
const INDEPENDENT_RUN_LENGTH: usize = 3;

#[must_use]
pub fn independent_await_runs(body: P<Node>) -> Vec<P<Node>> {
    let mut reported = Vec::new();
    scan_block(body, &mut reported);
    reported
}

fn scan_block(block: P<Node>, reported: &mut Vec<P<Node>>) {
    if block.kind() != Kind::Block {
        return;
    }
    let mut run = IndependentRun::default();
    for &statement in block.as_block().statements().nodes() {
        if run.extend(statement) {
            reported.push(statement);
        }
        scan_nested_blocks(statement, reported);
    }
}

fn scan_nested_blocks(statement: P<Node>, reported: &mut Vec<P<Node>>) {
    match statement.kind() {
        Kind::Block => scan_block(statement, reported),
        Kind::IfStatement => {
            let branch = statement.as_if_statement();
            scan_nested_blocks(branch.then_statement(), reported);
            if let Some(otherwise) = branch.else_statement() {
                scan_nested_blocks(otherwise, reported);
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct IndependentRun {
    bindings: FxHashSet<Binding>,
    length: usize,
}

impl IndependentRun {
    fn extend(&mut self, statement: P<Node>) -> bool {
        let Some((declaration, call)) = awaited_read_declaration(statement) else {
            *self = Self::default();
            return false;
        };
        let mut dependent = false;
        for_each_resolved_reference(call, true, &mut |binding| {
            dependent |= self.bindings.contains(&binding);
        });
        if dependent {
            *self = Self::default();
        }
        self.bindings.extend(declared_bindings(declaration));
        self.length += 1;
        self.length == INDEPENDENT_RUN_LENGTH
    }
}

fn awaited_read_declaration(statement: P<Node>) -> Option<(P<Node>, P<Node>)> {
    if statement.kind() != Kind::VariableStatement {
        return None;
    }
    let list = statement.as_variable_statement().declaration_list();
    let &[declaration] = list.as_variable_declaration_list().declarations().nodes() else {
        return None;
    };
    let awaited = unwrap_expression(declaration.as_variable_declaration().initializer()?);
    if !ast::is_await_expression(awaited) {
        return None;
    }
    let call = unwrap_expression(awaited.as_await_expression().expression());
    if call.kind() != Kind::CallExpression {
        return None;
    }
    let callee = call.as_call_expression().expression();
    if member_chain_root_identifier(callee) == Some("Promise") {
        return None;
    }
    let name = callee_name(call)?;
    let mutates = MUTATION_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix));
    (!mutates).then_some((declaration, call))
}

const OUTER_JOIN_METHODS: &[&str] = &["map", "filter", "flatMap", "reduce"];
const INNER_LOOKUP_METHODS: &[&str] = &["find", "filter", "some"];

fn method_receiver_and_name(node: P<Node>) -> Option<(P<Node>, &'static str)> {
    if node.kind() != Kind::CallExpression {
        return None;
    }
    let callee = unwrap_expression(node.as_call_expression().expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = callee.as_property_access_expression();
    Some((
        unwrap_expression(access.expression()),
        property_name_text(access.name())?,
    ))
}

fn callback_item_param(method: &str, callback: P<Node>) -> Option<&'static str> {
    let idx = usize::from(method == "reduce");
    let param = *callback.parameters().get(idx)?;
    let name = param.as_parameter_declaration().name();
    ast::is_identifier(name).then(|| name.as_identifier().text())
}

fn is_param_property_access(node: P<Node>, param_name: &str) -> bool {
    let unwrapped = unwrap_expression(node);
    if unwrapped.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let obj = unwrap_expression(unwrapped.as_property_access_expression().expression());
    ast::is_identifier(obj) && obj.as_identifier().text() == param_name
}

fn contains_key_equality(node: P<Node>, outer_param: &str, inner_param: &str) -> bool {
    let unwrapped = unwrap_expression(node);
    if unwrapped.kind() == Kind::BinaryExpression {
        let bin = unwrapped.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::EqualsEqualsEqualsToken | Kind::EqualsEqualsToken
        ) {
            let left = bin.left();
            let right = bin.right();
            if (is_param_property_access(left, inner_param)
                && is_param_property_access(right, outer_param))
                || (is_param_property_access(left, outer_param)
                    && is_param_property_access(right, inner_param))
            {
                return true;
            }
        }
    }
    let mut found = false;
    unwrapped.for_each_child(&mut |child| {
        if !is_function_like(child) && contains_key_equality(child, outer_param, inner_param) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn receiver_chain_parts(node: P<Node>) -> Option<(&'static str, Vec<&'static str>)> {
    let unwrapped = unwrap_expression(node);
    if ast::is_identifier(unwrapped) {
        return Some((unwrapped.as_identifier().text(), Vec::new()));
    }
    let (root, members) = static_member_chain(unwrapped)?;
    ast::is_identifier(root).then(|| (root.as_identifier().text(), members))
}

fn has_inner_key_lookup(node: P<Node>, outer_receiver: P<Node>, outer_param: &str) -> bool {
    if let Some((inner_receiver, inner_method)) = method_receiver_and_name(node)
        && INNER_LOOKUP_METHODS.contains(&inner_method)
        && let Some((inner_root, inner_members)) = receiver_chain_parts(inner_receiver)
        && inner_root != outer_param
        && receiver_chain_parts(outer_receiver)
            .is_none_or(|outer_parts| outer_parts != (inner_root, inner_members))
        && let Some(&inner_cb) = node.as_call_expression().arguments().nodes().first()
        && is_function_like(inner_cb)
        && let Some(inner_param) = callback_item_param(inner_method, inner_cb)
        && inner_param != outer_param
        && let Some(inner_body) = inner_cb.body()
        && contains_key_equality(inner_body, outer_param, inner_param)
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if !is_function_like(child) && has_inner_key_lookup(child, outer_receiver, outer_param) {
            found = true;
            return true;
        }
        false
    });
    found
}

#[must_use]
pub fn relational_key_join_calls(body: P<Node>) -> Vec<P<Node>> {
    let mut out = Vec::new();
    fn walk(node: P<Node>, out: &mut Vec<P<Node>>) {
        if let Some((outer_receiver, outer_method)) = method_receiver_and_name(node)
            && OUTER_JOIN_METHODS.contains(&outer_method)
            && let Some(&outer_cb) = node.as_call_expression().arguments().nodes().first()
            && is_function_like(outer_cb)
            && !function_returns_jsx(outer_cb)
            && let Some(outer_param) = callback_item_param(outer_method, outer_cb)
            && let Some(outer_body) = outer_cb.body()
            && has_inner_key_lookup(outer_body, outer_receiver, outer_param)
        {
            out.push(node);
        }
        node.for_each_child(&mut |child| {
            if !is_function_like(child) {
                walk(child, out);
            }
            false
        });
    }
    walk(body, &mut out);
    out
}
