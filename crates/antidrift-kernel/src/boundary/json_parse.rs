use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, NodeFlags, Symbol};
use tsrs_checker::{Checker, ContextFlags, TypeFlags};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrslint::utils::{is_source_file_default_library, is_type_flag_set};

use super::string_guard::{
    enclosing_scope_of_node, has_local_string_boundary, is_member_of_var,
    is_persisted_json_parse_call,
};
use crate::{provenance, tsrs_kernel};

#[must_use]
pub fn is_json_parse_call(node: P<Node>) -> bool {
    if !ast::is_call_expression(node) {
        return false;
    }
    let callee = node.as_call_expression().expression();
    if !ast::is_property_access_expression(callee) {
        return false;
    }
    let prop = callee.as_property_access_expression();
    let expr = prop.expression();
    if !ast::is_identifier(expr) || expr.as_identifier().text() != "JSON" {
        return false;
    }
    let name_node = prop.name();
    ast::is_identifier(name_node) && name_node.as_identifier().text() == "parse"
}

#[must_use]
pub fn is_json_stringify_call(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if !ast::is_call_expression(unwrapped) {
        return false;
    }
    let callee = unwrapped.as_call_expression().expression();
    if !ast::is_property_access_expression(callee) {
        return false;
    }
    let prop = callee.as_property_access_expression();
    let expr = prop.expression();
    if !ast::is_identifier(expr) || expr.as_identifier().text() != "JSON" {
        return false;
    }
    let name_node = prop.name();
    ast::is_identifier(name_node) && name_node.as_identifier().text() == "stringify"
}

fn contains_json_stringify(node: P<Node>) -> bool {
    if is_json_stringify_call(node) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if contains_json_stringify(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

fn is_family_callback_parameter(param_decl: P<Node>) -> bool {
    let Some(fn_node) = param_decl.parent() else {
        return false;
    };
    let Some(call_node) = fn_node.parent() else {
        return false;
    };
    if !ast::is_call_expression(call_node) {
        return false;
    }
    let callee = call_node.as_call_expression().expression();
    if ast::is_identifier(callee) {
        let text = callee.as_identifier().text();
        return text == "family" || text.ends_with("Family");
    }
    if ast::is_property_access_expression(callee) {
        let name = callee.as_property_access_expression().name();
        return ast::is_identifier(name)
            && (name.as_identifier().text() == "family"
                || name.as_identifier().text().ends_with("Family"));
    }
    false
}

fn is_direct_json_stringify_expr(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if is_json_stringify_call(unwrapped) {
        return true;
    }
    if unwrapped.kind() == Kind::ConditionalExpression {
        let cond = unwrapped.as_conditional_expression();
        return is_direct_json_stringify_expr(cond.when_true())
            || is_direct_json_stringify_expr(cond.when_false());
    }
    false
}

pub fn is_json_stringify_roundtrip(checker: &mut Checker, call_node: P<Node>) -> bool {
    if !is_json_parse_call(call_node) {
        return false;
    }
    let args = call_node.as_call_expression().arguments().nodes();
    let Some(&first_arg) = args.first() else {
        return false;
    };
    let arg = tsrs_kernel::unwrap_expression(first_arg);
    if is_json_stringify_call(arg) {
        return true;
    }
    if !ast::is_identifier(arg) {
        return false;
    }
    let sym = provenance::symbol_at_node(checker, arg);
    for decl in provenance::symbol_declarations(checker, sym) {
        if ast::is_variable_declaration(decl)
            && decl
                .as_variable_declaration()
                .initializer()
                .is_some_and(is_direct_json_stringify_expr)
        {
            return true;
        }
        if decl.kind() == Kind::Parameter
            && is_family_callback_parameter(decl)
            && let Some(sf) = ast::get_source_file_of_node(call_node)
            && contains_json_stringify(sf.as_node())
        {
            return true;
        }
    }
    false
}

pub fn is_global_json_parse(
    program: Option<&Program>,
    checker: &mut Checker,
    node: P<Node>,
) -> bool {
    if !is_json_parse_call(node) {
        return false;
    }
    let obj = node
        .as_call_expression()
        .expression()
        .as_property_access_expression()
        .expression();
    let Some(sym) = checker.get_symbol_at_location_exported(obj) else {
        return false;
    };
    for &decl in sym.declarations() {
        if let Some(sf) = ast::get_source_file_of_node(decl)
            && (program.is_some_and(|prog| is_source_file_default_library(prog, sf))
                || sf.file_name().contains("lib."))
        {
            return true;
        }
    }
    false
}

pub fn parsed_json_origin(
    program: Option<&Program>,
    checker: &mut Checker,
    node: Option<P<Node>>,
    seen: &mut FxHashSet<P<Symbol>>,
) -> Option<P<Node>> {
    let curr = node?;
    if is_global_json_parse(program, checker, curr) {
        return Some(curr);
    }
    if !ast::is_identifier(curr) {
        return None;
    }
    let sym = provenance::symbol_at_node(checker, curr)?;
    if !seen.insert(sym) {
        return None;
    }
    for decl in provenance::symbol_declarations(checker, Some(sym)) {
        if ast::is_variable_declaration(decl) {
            if !decl
                .parent()
                .is_some_and(|parent| parent.flags().intersects(NodeFlags::Const))
            {
                return None;
            }
            return parsed_json_origin(
                program,
                checker,
                decl.as_variable_declaration().initializer(),
                seen,
            );
        }
    }
    None
}

fn is_non_value_identifier(node: P<Node>) -> bool {
    if node.kind() != Kind::Identifier {
        return false;
    }
    let Some(parent) = node.parent() else {
        return true;
    };
    if parent.kind() == Kind::PropertyAccessExpression
        && parent.as_property_access_expression().name() == node
    {
        return true;
    }
    if parent.kind() == Kind::VariableDeclaration && parent.as_variable_declaration().name() == node
    {
        return true;
    }
    if parent.kind() == Kind::PropertyAssignment && parent.as_property_assignment().name() == node {
        return true;
    }
    if parent.kind() == Kind::CallExpression && parent.as_call_expression().expression() == node {
        return true;
    }
    matches!(
        parent.kind(),
        Kind::QualifiedName
            | Kind::TypeReference
            | Kind::TypeParameter
            | Kind::InterfaceDeclaration
            | Kind::TypeAliasDeclaration
            | Kind::PropertySignature
            | Kind::MethodSignature
            | Kind::ImportSpecifier
            | Kind::ImportClause
            | Kind::NamespaceImport
            | Kind::ExportSpecifier
            | Kind::BindingElement
            | Kind::Parameter
            | Kind::FunctionDeclaration
            | Kind::MethodDeclaration
            | Kind::ClassDeclaration
            | Kind::EnumDeclaration
            | Kind::EnumMember
    )
}

pub fn parsed_json_target(
    program: Option<&Program>,
    checker: &mut Checker,
    node: P<Node>,
) -> String {
    if is_non_value_identifier(node) {
        return String::new();
    }
    let mut seen = FxHashSet::default();
    if parsed_json_origin(program, checker, Some(node), &mut seen).is_none() {
        return String::new();
    }
    let Some(target) = checker.get_contextual_type_exported(node, ContextFlags::None) else {
        return String::new();
    };
    if is_type_flag_set(target, TypeFlags::AnyOrUnknown) {
        return String::new();
    }
    checker.type_to_string_exported(target)
}

pub fn is_unsafe_json_parse_input(checker: &mut Checker, call_node: P<Node>) -> bool {
    if !is_json_parse_call(call_node) {
        return false;
    }
    let args = call_node.as_call_expression().arguments().nodes();
    let Some(&arg) = args.first() else {
        return false;
    };
    let arg_type = checker.get_type_at_location(arg);
    is_type_flag_set(arg_type, TypeFlags::AnyOrUnknown)
        && !has_local_string_boundary(call_node, arg)
}

fn is_array_or_record_guard_call(node: P<Node>, var_name: &str) -> Option<&'static str> {
    if !ast::is_call_expression(node) {
        return None;
    }
    let call = node.as_call_expression();
    let &arg = call.arguments().nodes().first()?;
    let prop = is_member_of_var(arg, var_name)?;
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    if ast::is_identifier(callee) && callee.as_identifier().text() == "isRecord" {
        return Some(prop);
    }
    if ast::is_property_access_expression(callee) {
        let pa = callee.as_property_access_expression();
        if ast::is_identifier(pa.expression())
            && pa.expression().as_identifier().text() == "Array"
            && ast::is_identifier(pa.name())
            && pa.name().as_identifier().text() == "isArray"
        {
            return Some(prop);
        }
    }
    None
}

fn record_var_member_usage(
    node: P<Node>,
    var_name: &str,
    read_props: &mut FxHashSet<&'static str>,
    guarded_props: &mut FxHashSet<&'static str>,
    has_unguarded_element: &mut bool,
) {
    if node.kind() == Kind::TypeOfExpression
        && let Some(prop) = is_member_of_var(node.as_type_of_expression().expression(), var_name)
    {
        guarded_props.insert(prop);
    } else if let Some(prop) = is_array_or_record_guard_call(node, var_name) {
        guarded_props.insert(prop);
    } else if node.kind() == Kind::BinaryExpression {
        let bin = node.as_binary_expression();
        let right = tsrs_kernel::unwrap_expression(bin.right());
        let left = tsrs_kernel::unwrap_expression(bin.left());
        if bin.operator_token().kind() == Kind::InKeyword
            && ast::is_identifier(right)
            && right.as_identifier().text() == var_name
            && let Some(key) = tsrs_kernel::property_name_text(left)
        {
            guarded_props.insert(key);
        }
    } else if let Some(prop) = is_member_of_var(node, var_name) {
        read_props.insert(prop);
    } else if node.kind() == Kind::ElementAccessExpression {
        let recv = tsrs_kernel::unwrap_expression(node.as_element_access_expression().expression());
        if ast::is_identifier(recv) && recv.as_identifier().text() == var_name {
            *has_unguarded_element = true;
        }
    }
    node.for_each_child(&mut |child| {
        if !tsrs_kernel::is_function_like(child) {
            record_var_member_usage(
                child,
                var_name,
                read_props,
                guarded_props,
                has_unguarded_element,
            );
        }
        false
    });
}

fn has_unguarded_decl_member_access(decl_node: P<Node>) -> bool {
    let decl = decl_node.as_variable_declaration();
    if decl
        .type_()
        .is_some_and(|t| !matches!(t.kind(), Kind::UnknownKeyword | Kind::AnyKeyword))
    {
        return false;
    }
    if decl.name().kind() == Kind::ObjectBindingPattern {
        return true;
    }
    if !ast::is_identifier(decl.name()) {
        return false;
    }
    let var_name = decl.name().as_identifier().text();
    let scope = enclosing_scope_of_node(decl_node);
    let mut read_props = FxHashSet::default();
    let mut guarded_props = FxHashSet::default();
    let mut has_unguarded_element = false;
    record_var_member_usage(
        scope,
        var_name,
        &mut read_props,
        &mut guarded_props,
        &mut has_unguarded_element,
    );
    has_unguarded_element || read_props.iter().any(|prop| !guarded_props.contains(prop))
}

pub fn has_unguarded_persisted_json_property_access(
    checker: &mut Checker,
    call_node: P<Node>,
) -> bool {
    if !is_json_parse_call(call_node) || !is_persisted_json_parse_call(call_node) {
        return false;
    }
    let Some(parent) = call_node.parent() else {
        return false;
    };
    if ast::is_call_expression(parent)
        && super::schema::schema_validation_call_parts(parent, checker).is_some()
    {
        return false;
    }
    if matches!(
        parent.kind(),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression
    ) {
        return true;
    }
    parent.kind() == Kind::VariableDeclaration && has_unguarded_decl_member_access(parent)
}
