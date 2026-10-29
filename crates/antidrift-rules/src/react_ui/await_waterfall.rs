use antidrift_kernel::async_effects::{
    IndependentAwaitRun, is_discard_binding_name, is_effect_callee_name,
};
use antidrift_kernel::local_binding::{Binding, declared_bindings, for_each_resolved_reference};
use antidrift_kernel::relational_scan::{
    is_cross_param_key_pair, is_inner_linear_scan_method, is_outer_traversal_method,
};
use antidrift_kernel::tsrs_kernel::{
    callee_name, is_function_like, member_chain_root_identifier, property_name_text,
    static_member_chain, unwrap_expression,
};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

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
    let mut run = IndependentAwaitRun::<Binding>::default();
    for &statement in block.as_block().statements().nodes() {
        if extend_run(&mut run, statement) {
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

fn extend_run(run: &mut IndependentAwaitRun<Binding>, statement: P<Node>) -> bool {
    let Some((declaration, call)) = awaited_read_declaration(statement) else {
        run.reset();
        return false;
    };
    let mut dependent = false;
    for_each_resolved_reference(call, true, &mut |binding| {
        dependent |= run.depends_on(&binding);
    });
    let declared: Vec<Binding> = declared_bindings(declaration)
        .into_iter()
        .filter(|binding| !is_discard_binding_name(binding.name()))
        .collect();
    run.extend(declared, dependent)
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
    (!is_effect_callee_name(name)).then_some((declaration, call))
}

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

fn property_access_root(node: P<Node>) -> Option<&'static str> {
    let unwrapped = unwrap_expression(node);
    if unwrapped.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let obj = unwrap_expression(unwrapped.as_property_access_expression().expression());
    ast::is_identifier(obj).then(|| obj.as_identifier().text())
}

fn contains_key_equality(node: P<Node>, outer_param: &str, inner_param: &str) -> bool {
    let unwrapped = unwrap_expression(node);
    if unwrapped.kind() == Kind::BinaryExpression {
        let bin = unwrapped.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::EqualsEqualsEqualsToken | Kind::EqualsEqualsToken
        ) && is_cross_param_key_pair(
            property_access_root(bin.left()),
            property_access_root(bin.right()),
            outer_param,
            inner_param,
        ) {
            return true;
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

fn has_inner_key_lookup(node: P<Node>, outer_param: &str) -> bool {
    if let Some((inner_receiver, inner_method)) = method_receiver_and_name(node)
        && is_inner_linear_scan_method(inner_method)
        && let Some((inner_root, _)) = receiver_chain_parts(inner_receiver)
        && inner_root != outer_param
        && let Some(&inner_cb) = node.as_call_expression().arguments().nodes().first()
        && is_function_like(inner_cb)
        && let Some(inner_param) = callback_item_param(inner_method, inner_cb)
        && let Some(inner_body) = inner_cb.body()
        && contains_key_equality(inner_body, outer_param, inner_param)
    {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if !is_function_like(child) && has_inner_key_lookup(child, outer_param) {
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
        if let Some((_, outer_method)) = method_receiver_and_name(node)
            && is_outer_traversal_method(outer_method)
            && let Some(&outer_cb) = node.as_call_expression().arguments().nodes().first()
            && is_function_like(outer_cb)
            && let Some(outer_param) = callback_item_param(outer_method, outer_cb)
            && let Some(outer_body) = outer_cb.body()
            && has_inner_key_lookup(outer_body, outer_param)
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
