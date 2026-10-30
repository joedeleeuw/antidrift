use crate::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::{is_object_type, is_type_flag_set};

use crate::{provenance, shape};

use super::schema::{is_effect_schema_method, is_valibot_method, is_zod_method};

const THROW_ASSERTION_MATCHERS: &[&str] = &["toThrow", "toThrowError"];

#[derive(Clone, Copy, Debug)]
pub struct ZodTransformCall {
    pub receiver: P<Node>,
    pub callback: P<Node>,
}

fn is_expect_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let callee = node.as_call_expression().expression();
    if ast::is_identifier(callee) {
        return callee.as_identifier().text() == "expect";
    }
    if ast::is_property_access_expression(callee) {
        let obj = callee.as_property_access_expression().expression();
        return ast::is_identifier(obj) && obj.as_identifier().text() == "expect";
    }
    false
}

fn is_called_expression(curr: P<Node>) -> bool {
    curr.parent().is_some_and(|parent| {
        ast::is_call_expression(parent) && parent.as_call_expression().expression() == curr
    })
}

fn has_throw_assertion_matcher(expect_call: P<Node>) -> bool {
    let mut current = expect_call.parent();
    while let Some(curr) = current {
        if ast::is_property_access_expression(curr) {
            let name_node = curr.as_property_access_expression().name();
            if ast::is_identifier(name_node)
                && THROW_ASSERTION_MATCHERS.contains(&name_node.as_identifier().text())
            {
                return is_called_expression(curr);
            }
            current = curr.parent();
            continue;
        }
        if ast::is_call_expression(curr) || ast::is_non_null_expression(curr) {
            current = curr.parent();
            continue;
        }
        break;
    }
    false
}

#[must_use]
pub fn is_throw_assertion_callback_parse(call_node: P<Node>) -> bool {
    let mut fn_node = None;
    let mut current = call_node.parent();
    while let Some(curr) = current {
        if matches!(curr.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
            fn_node = Some(curr);
            break;
        }
        if curr.kind() == Kind::FunctionDeclaration {
            return false;
        }
        current = curr.parent();
    }
    let Some(func) = fn_node else {
        return false;
    };
    let Some(body) = func.body() else {
        return false;
    };
    let is_direct = body == call_node
        || call_node.parent().is_some_and(|parent| {
            ast::is_expression_statement(parent) && parent.parent() == Some(body)
        });
    let Some(expect_call) = func.parent() else {
        return false;
    };
    is_direct
        && ast::is_call_expression(expect_call)
        && is_expect_call(expect_call)
        && has_throw_assertion_matcher(expect_call)
}

fn has_use_server_directive(statements: &[P<Node>]) -> bool {
    for &stmt in statements {
        if !ast::is_expression_statement(stmt) {
            return false;
        }
        let expr = stmt.as_expression_statement().expression();
        if !ast::is_string_literal(expr) {
            return false;
        }
        if cooked_text(expr) == Some("use server") {
            return true;
        }
    }
    false
}

pub fn is_server_action_parameter(checker: &mut Checker, param_decl: P<Node>) -> bool {
    let Some(declaring_fn) = param_decl.parent() else {
        return false;
    };
    if let Some(body) = declaring_fn.body()
        && ast::is_block(body)
        && has_use_server_directive(body.as_block().statements().nodes())
    {
        return true;
    }
    let Some(sf) = ast::get_source_file_of_node(declaring_fn) else {
        return false;
    };
    if !has_use_server_directive(sf.statements().nodes()) {
        return false;
    }
    let Some(mod_sym) = checker.get_symbol_at_location_exported(sf.as_node()) else {
        return false;
    };
    let target_decl = match declaring_fn.parent() {
        Some(parent) if ast::is_variable_declaration(parent) => parent,
        _ => declaring_fn,
    };
    for exp_sym in checker.get_exports_of_module_exported(mod_sym) {
        let resolved = provenance::resolve_aliased_symbol(checker, exp_sym);
        if resolved.declarations().contains(&target_decl) {
            return true;
        }
    }
    false
}

pub fn zod_transform_call_parts(
    call_node: P<Node>,
    checker: &mut Checker,
) -> Option<ZodTransformCall> {
    if !ast::is_call_expression(call_node) {
        return None;
    }
    let call = call_node.as_call_expression();
    let args = call.arguments().nodes();
    if args.len() != 1 {
        return None;
    }
    let cb = args[0];
    if !matches!(cb.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
        return None;
    }
    let callee = call.expression();
    if ast::is_property_access_expression(callee) {
        let prop = callee.as_property_access_expression();
        let name_node = prop.name();
        if !ast::is_identifier(name_node) || name_node.as_identifier().text() != "transform" {
            return None;
        }
        if !is_zod_method(checker, name_node)
            && !is_valibot_method(checker, name_node)
            && !is_effect_schema_method(checker, name_node)
        {
            return None;
        }
        if let Some(parent) = call_node.parent()
            && ast::is_call_expression(parent)
            && let Some(&first_pipe_arg) = parent.as_call_expression().arguments().nodes().first()
            && first_pipe_arg != call_node
        {
            return Some(ZodTransformCall {
                receiver: first_pipe_arg,
                callback: cb,
            });
        }
        return Some(ZodTransformCall {
            receiver: prop.expression(),
            callback: cb,
        });
    }
    if ast::is_identifier(callee)
        && callee.as_identifier().text() == "transform"
        && (is_valibot_method(checker, callee) || is_effect_schema_method(checker, callee))
        && let Some(parent) = call_node.parent()
        && ast::is_call_expression(parent)
        && let Some(&first_pipe_arg) = parent.as_call_expression().arguments().nodes().first()
        && first_pipe_arg != call_node
    {
        return Some(ZodTransformCall {
            receiver: first_pipe_arg,
            callback: cb,
        });
    }
    None
}

fn closed_type_property_names(checker: &mut Checker, input_type: P<Type>) -> Vec<String> {
    if is_type_flag_set(input_type, TypeFlags::AnyOrUnknown) {
        return Vec::new();
    }
    if is_type_flag_set(input_type, TypeFlags::Union) {
        let mut iter = input_type.as_union_type().types().iter().copied();
        let Some(first_member) = iter.next() else {
            return Vec::new();
        };
        let mut first_keys = closed_type_property_names(checker, first_member);
        if first_keys.is_empty() {
            return Vec::new();
        }
        first_keys.sort();
        for member in iter {
            let mut member_keys = closed_type_property_names(checker, member);
            member_keys.sort();
            if member_keys != first_keys {
                return Vec::new();
            }
        }
        return first_keys;
    }
    if !is_object_type(input_type)
        || shape::has_string_or_number_index_signature(checker, input_type)
    {
        return Vec::new();
    }
    shape::object_property_names(checker, input_type)
}

pub fn closed_zod_transform_input_keys(receiver: P<Node>, checker: &mut Checker) -> Vec<String> {
    let receiver_type = checker.get_type_at_location(receiver);
    if let Some(output_sym) = checker.get_property_of_type(receiver_type, "_output")
        && let Some(input_type) = checker.get_type_of_symbol_at_location(output_sym, Some(receiver))
    {
        let keys = closed_type_property_names(checker, input_type);
        if !keys.is_empty() {
            return keys;
        }
    }
    if let Some(prop) = receiver.parent()
        && let Some(call) = prop.parent()
        && ast::is_call_expression(call)
        && let Some(&cb) = call.as_call_expression().arguments().nodes().first()
        && let Some(&param) = cb.parameters().first()
    {
        let param_type = checker.get_type_at_location(param);
        return closed_type_property_names(checker, param_type);
    }
    Vec::new()
}
