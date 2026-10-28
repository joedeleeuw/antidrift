use tsrs_ast::{self as ast, CallExpression, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::{provenance, tsrs_kernel};

use super::schema::{package_name_of_path, symbol_package_path};

const CONVEX_REGISTRARS: &[&str] = &[
    "query",
    "mutation",
    "action",
    "internalQuery",
    "internalMutation",
    "internalAction",
];
const CONVEX_COMBINATORS: &[&str] = &["array", "optional", "union", "record"];

fn symbol_declares_in_convex_path(
    checker: &mut Checker,
    sym: Option<P<Symbol>>,
    segment: &str,
) -> bool {
    let rest = symbol_package_path(checker, sym);
    rest.starts_with("convex/") && rest.contains(segment)
}

pub fn is_convex_registrar_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    if !ast::is_call_expression(call_node) {
        return false;
    }
    let callee = call_node.as_call_expression().expression();
    let target = if ast::is_property_access_expression(callee) {
        callee.as_property_access_expression().name()
    } else {
        callee
    };
    if !ast::is_identifier(target) {
        return false;
    }
    let sym = provenance::symbol_at_node(checker, target);
    let raw_name = sym
        .as_deref()
        .map(Symbol::name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| target.as_identifier().text());
    let bare_name = raw_name.strip_suffix("Generic").unwrap_or(raw_name);
    if !CONVEX_REGISTRARS.contains(&bare_name) {
        return false;
    }
    if symbol_declares_in_convex_path(checker, sym, "/server") {
        return true;
    }
    let callee_type = match sym {
        Some(symbol) => checker.get_type_of_symbol_at_location(symbol, Some(target)),
        None => Some(checker.get_type_at_location(callee)),
    };
    let Some(resolved_type) = callee_type else {
        return false;
    };
    symbol_declares_in_convex_path(checker, provenance::type_symbol(resolved_type), "/server")
}

pub fn convex_validator_method(checker: &mut Checker, node: P<Node>) -> String {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if !ast::is_call_expression(unwrapped) {
        return String::new();
    }
    let callee = unwrapped.as_call_expression().expression();
    if !ast::is_property_access_expression(callee) {
        return String::new();
    }
    let prop = callee.as_property_access_expression();
    let name_node = prop.name();
    if !ast::is_identifier(name_node) {
        return String::new();
    }
    let method_sym = provenance::symbol_at_node(checker, name_node);
    let receiver_sym = provenance::symbol_at_node(checker, prop.expression());
    if !symbol_declares_in_convex_path(checker, method_sym, "/values")
        && !symbol_declares_in_convex_path(checker, receiver_sym, "/values")
    {
        return String::new();
    }
    name_node.as_identifier().text().to_string()
}

fn convex_object_contains_any(checker: &mut Checker, call: &CallExpression) -> bool {
    let Some(&first_arg) = call.arguments().nodes().first() else {
        return false;
    };
    let fields = tsrs_kernel::unwrap_expression(first_arg);
    if !ast::is_object_literal_expression(fields) {
        return false;
    }
    let props = fields.as_object_literal_expression().properties().nodes();
    for &prop in props {
        if ast::is_property_assignment(prop)
            && contains_convex_any(checker, prop.as_property_assignment().initializer())
        {
            return true;
        }
    }
    false
}

pub fn contains_convex_any(checker: &mut Checker, node: P<Node>) -> bool {
    let target = tsrs_kernel::unwrap_expression(node);
    if !ast::is_call_expression(target) {
        return false;
    }
    let call = target.as_call_expression();
    let method = convex_validator_method(checker, target);
    match method.as_str() {
        "any" => return call.arguments().nodes().is_empty(),
        "object" => return convex_object_contains_any(checker, call),
        _ => {}
    }
    if CONVEX_COMBINATORS.contains(&method.as_str()) {
        for &arg in call.arguments().nodes() {
            if contains_convex_any(checker, arg) {
                return true;
            }
        }
    }
    false
}

fn is_json_schema_conversion_call_expr(
    checker: &mut Checker,
    call_node: P<Node>,
    depth: usize,
) -> bool {
    if is_json_schema_conversion_call(checker, call_node) {
        return true;
    }
    for &arg in call_node.as_call_expression().arguments().nodes() {
        if is_json_schema_conversion_result(checker, arg, depth - 1) {
            return true;
        }
    }
    false
}

fn is_json_schema_conversion_ident(
    checker: &mut Checker,
    ident_node: P<Node>,
    depth: usize,
) -> bool {
    let sym = provenance::symbol_at_node(checker, ident_node);
    for decl in provenance::symbol_declarations(checker, sym) {
        if ast::is_variable_declaration(decl)
            && let Some(init) = decl.as_variable_declaration().initializer()
            && is_json_schema_conversion_result(checker, init, depth - 1)
        {
            return true;
        }
    }
    false
}

pub fn is_json_schema_conversion_result(
    checker: &mut Checker,
    node: P<Node>,
    depth: usize,
) -> bool {
    if depth == 0 {
        return false;
    }
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if ast::is_call_expression(unwrapped) {
        return is_json_schema_conversion_call_expr(checker, unwrapped, depth);
    }
    if ast::is_identifier(unwrapped) {
        return is_json_schema_conversion_ident(checker, unwrapped, depth);
    }
    false
}

fn is_json_schema_conversion_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let callee = call.expression();
    let sym = if ast::is_property_access_expression(callee) {
        let prop = callee.as_property_access_expression();
        let name_node = prop.name();
        if ast::is_identifier(name_node) && name_node.as_identifier().text() == "toJSONSchema" {
            let prop_sym = provenance::symbol_at_node(checker, name_node);
            let rest = symbol_package_path(checker, prop_sym);
            if rest == "zod" || rest.starts_with("zod/") {
                return true;
            }
        }
        provenance::symbol_at_node(checker, name_node)
    } else if ast::is_identifier(callee) {
        provenance::symbol_at_node(checker, callee)
    } else {
        None
    };
    let Some(symbol) = sym else {
        return false;
    };
    let rest = symbol_package_path(checker, Some(symbol));
    if symbol.name() == "make" && rest.starts_with("effect/") && rest.contains("JSONSchema") {
        return true;
    }
    symbol.name() == "toJsonSchema" && rest.starts_with("@valibot/to-json-schema")
}

pub fn is_openapi_documentation_call(checker: &mut Checker, call_node: P<Node>) -> bool {
    if !ast::is_call_expression(call_node) {
        return false;
    }
    let callee = call_node.as_call_expression().expression();
    let target = if ast::is_property_access_expression(callee) {
        callee.as_property_access_expression().name()
    } else {
        callee
    };
    let sym = provenance::symbol_at_node(checker, target);
    let rest = symbol_package_path(checker, sym);
    !rest.is_empty()
        && package_name_of_path(&rest)
            .to_ascii_lowercase()
            .contains("openapi")
}
