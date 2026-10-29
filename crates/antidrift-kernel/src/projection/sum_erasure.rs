use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

use crate::tsrs_kernel;

const LIFECYCLE_BOOL_FIELDS: &[&str] = &[
    "loading",
    "isLoading",
    "pending",
    "isPending",
    "isFetching",
    "waiting",
];

const ERROR_FIELDS: &[&str] = &["error", "errorMessage"];

const DISCRIMINANT_NAMES: &[&str] = &["_tag", "tag", "status", "state", "phase", "kind"];

const DISCRIMINANT_SUFFIXES: &[&str] = &["Status", "State", "Phase", "Tag"];

fn is_discriminant_property_name(name: &str) -> bool {
    DISCRIMINANT_NAMES.contains(&name)
        || DISCRIMINANT_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn property_name_and_value(prop: P<Node>) -> Option<(&'static str, P<Node>)> {
    match prop.kind() {
        Kind::PropertyAssignment => {
            let assign = prop.as_property_assignment();
            let name = tsrs_kernel::property_name_text(assign.name())?;
            Some((name, tsrs_kernel::unwrap_expression(assign.initializer())))
        }
        Kind::ShorthandPropertyAssignment => {
            let short = prop.as_shorthand_property_assignment();
            let name_node = short.name();
            ast::is_identifier(name_node).then(|| (name_node.as_identifier().text(), name_node))
        }
        _ => None,
    }
}

fn find_local_initializer(scope_root: P<Node>, target_ident: &str) -> Option<P<Node>> {
    let mut found = None;
    fn walk(node: P<Node>, target: &str, out: &mut Option<P<Node>>) {
        if out.is_some() {
            return;
        }
        if node.kind() == Kind::VariableDeclaration {
            let decl = node.as_variable_declaration();
            let name = decl.name();
            if ast::is_identifier(name) && name.as_identifier().text() == target {
                *out = decl.initializer().map(tsrs_kernel::unwrap_expression);
                return;
            }
        }
        node.for_each_child(&mut |child| {
            if !tsrs_kernel::is_function_like(child) {
                walk(child, target, out);
            }
            false
        });
    }
    walk(scope_root, target_ident, &mut found);
    found
}

fn extract_discriminant_comparison(node: P<Node>) -> Option<&'static str> {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if unwrapped.kind() == Kind::BinaryExpression {
        let bin = unwrapped.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::EqualsEqualsToken
                | Kind::EqualsEqualsEqualsToken
                | Kind::ExclamationEqualsToken
                | Kind::ExclamationEqualsEqualsToken
        ) {
            let left = tsrs_kernel::unwrap_expression(bin.left());
            let right = tsrs_kernel::unwrap_expression(bin.right());
            let prop_side = if ast::is_string_literal(right) {
                Some(left)
            } else if ast::is_string_literal(left) {
                Some(right)
            } else {
                None
            };
            if let Some(side) = prop_side
                && side.kind() == Kind::PropertyAccessExpression
                && let Some(prop_name) =
                    tsrs_kernel::property_name_text(side.as_property_access_expression().name())
                && is_discriminant_property_name(prop_name)
            {
                return Some(prop_name);
            }
        }
    }
    let mut found = None;
    unwrapped.for_each_child(&mut |child| {
        if found.is_none() && !tsrs_kernel::is_function_like(child) {
            found = extract_discriminant_comparison(child);
        }
        found.is_some()
    });
    found
}

#[must_use]
pub fn find_sum_to_product_erasure(obj_node: P<Node>) -> Option<String> {
    if obj_node.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    let props = obj_node.as_object_literal_expression().properties().nodes();
    if props.len() < 2 {
        return None;
    }
    let mut has_dynamic_lifecycle_bool = false;
    let mut has_error_field = false;
    let mut values = Vec::with_capacity(props.len());
    for &prop in props {
        let Some((name, val)) = property_name_and_value(prop) else {
            continue;
        };
        if LIFECYCLE_BOOL_FIELDS.contains(&name)
            && !matches!(val.kind(), Kind::TrueKeyword | Kind::FalseKeyword)
        {
            has_dynamic_lifecycle_bool = true;
        }
        if ERROR_FIELDS.contains(&name) {
            has_error_field = true;
        }
        values.push(val);
    }
    if !has_dynamic_lifecycle_bool || !has_error_field {
        return None;
    }
    let scope_root = tsrs_kernel::enclosing_function(obj_node);
    for val in values {
        if let Some(disc) = extract_discriminant_comparison(val) {
            return Some(disc.to_owned());
        }
        if ast::is_identifier(val)
            && let Some(root) = scope_root
            && let Some(init) = find_local_initializer(root, val.as_identifier().text())
            && let Some(disc) = extract_discriminant_comparison(init)
        {
            return Some(disc.to_owned());
        }
    }
    None
}
