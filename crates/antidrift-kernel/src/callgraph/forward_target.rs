use crate::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::tsrs_kernel;

pub(super) fn outer_expression(node: P<Node>) -> P<Node> {
    let mut current = node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            Kind::AsExpression
            | Kind::NonNullExpression
            | Kind::SatisfiesExpression
            | Kind::ParenthesizedExpression => {
                current = parent;
            }
            _ => return current,
        }
    }
    current
}

pub(super) fn is_call_argument(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::CallExpression => parent
            .as_call_expression()
            .arguments()
            .nodes()
            .contains(&node),
        Kind::NewExpression => parent
            .as_new_expression()
            .arguments()
            .is_some_and(|args| args.nodes().contains(&node)),
        _ => false,
    }
}

fn root_callee_expr(node: P<Node>) -> P<Node> {
    let mut current = node;
    while ast::is_property_access_expression(current) {
        current = current.as_property_access_expression().expression();
    }
    current
}

fn is_first_party_specifier(spec: &str) -> bool {
    spec.starts_with("./")
        || spec.starts_with("../")
        || spec.starts_with("@/")
        || spec.starts_with("~/")
        || spec.starts_with("#/")
}

fn is_callable_expression_kind(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::ArrowFunction | Kind::FunctionExpression | Kind::ClassExpression
    )
}

fn defines_callable(init: Option<P<Node>>) -> bool {
    let Some(init_node) = init else {
        return false;
    };
    let unwrapped = tsrs_kernel::unwrap_expression(init_node);
    if is_callable_expression_kind(unwrapped.kind()) {
        return true;
    }
    if unwrapped.kind() == Kind::CallExpression
        && let Some(&first_arg) = unwrapped.as_call_expression().arguments().nodes().first()
    {
        let arg0 = tsrs_kernel::unwrap_expression(first_arg);
        return is_callable_expression_kind(arg0.kind());
    }
    false
}

fn is_imported_first_party_declaration(decl: P<Node>, callee: P<Node>, root: P<Node>) -> bool {
    let mut cur = Some(decl);
    let mut import_decl = None;
    while let Some(node) = cur {
        if ast::is_import_declaration(node) {
            import_decl = Some(node);
            break;
        }
        cur = node.parent();
    }
    let Some(import_node) = import_decl else {
        return false;
    };
    let spec_node = import_node.as_import_declaration().module_specifier();
    if !ast::is_string_literal(spec_node) {
        return false;
    }
    cooked_text(spec_node).is_some_and(is_first_party_specifier)
        && (callee == root || decl.kind() == Kind::NamespaceImport)
}

fn is_first_party_layer_callee(callee: P<Node>, checker: &mut Checker) -> bool {
    let root = root_callee_expr(callee);
    if root.kind() == Kind::ThisKeyword {
        return ast::is_property_access_expression(callee)
            && callee.as_property_access_expression().expression() == root;
    }
    if !ast::is_identifier(root)
        && !matches!(
            root.kind(),
            Kind::JsxOpeningElement | Kind::JsxSelfClosingElement
        )
    {
        return false;
    }
    let Some(sym) = checker.get_symbol_at_location_exported(root) else {
        return false;
    };
    let Some(&decl) = sym.declarations().first() else {
        return false;
    };
    match decl.kind() {
        Kind::ImportSpecifier | Kind::ImportClause | Kind::NamespaceImport => {
            is_imported_first_party_declaration(decl, callee, root)
        }
        Kind::FunctionDeclaration | Kind::ClassDeclaration => callee == root,
        Kind::VariableDeclaration => {
            callee == root && defines_callable(decl.as_variable_declaration().initializer())
        }
        _ => false,
    }
}

fn is_delegated_call_parent(node: P<Node>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        Kind::ExpressionStatement | Kind::ReturnStatement => true,
        Kind::ArrowFunction => parent.body() == Some(node),
        _ => false,
    }
}

fn is_delegated_result_call(call: P<Node>) -> bool {
    let mut node = outer_expression(call);
    while let Some(parent) = node.parent() {
        match parent.kind() {
            Kind::AwaitExpression | Kind::VoidExpression | Kind::NonNullExpression => {
                node = outer_expression(parent);
            }
            _ => return is_delegated_call_parent(node),
        }
    }
    is_delegated_call_parent(node)
}

fn forwarding_call_for_identifier(node: P<Node>) -> Option<P<Node>> {
    let parent = node.parent()?;
    if is_call_argument(node) {
        return Some(parent);
    }
    if ast::is_spread_element(parent) && is_call_argument(parent) {
        return parent.parent();
    }
    if (ast::is_spread_assignment(parent) || ast::is_shorthand_property_assignment(parent))
        && let Some(grandparent) = parent.parent()
        && ast::is_object_literal_expression(grandparent)
        && is_call_argument(grandparent)
    {
        return grandparent.parent();
    }
    None
}

fn forwarding_jsx_tag_name_for_identifier(node: P<Node>) -> Option<P<Node>> {
    let parent = node.parent()?;
    let jsx_attrs = match parent.kind() {
        Kind::JsxExpression => {
            let grandparent = parent.parent()?;
            (grandparent.kind() == Kind::JsxAttribute)
                .then(|| grandparent.parent())
                .flatten()
        }
        Kind::JsxSpreadAttribute => parent.parent(),
        _ => None,
    }?;
    let elem = jsx_attrs.parent()?;
    matches!(
        elem.kind(),
        Kind::JsxOpeningElement | Kind::JsxSelfClosingElement
    )
    .then(|| elem.tag_name())
}

fn is_expression_statement_call(call: P<Node>) -> bool {
    let mut node = outer_expression(call);
    while let Some(parent) = node.parent() {
        match parent.kind() {
            Kind::AwaitExpression | Kind::VoidExpression | Kind::NonNullExpression => {
                node = outer_expression(parent);
            }
            Kind::ExpressionStatement => return true,
            _ => return false,
        }
    }
    false
}

fn call_joins_local_variable(call: P<Node>, param_ident: P<Node>, checker: &mut Checker) -> bool {
    if !ast::is_call_expression(call) || !is_expression_statement_call(call) {
        return false;
    }
    let Some(enclosing_fn) = tsrs_kernel::enclosing_function(call) else {
        return false;
    };
    for &arg in call.as_call_expression().arguments().nodes() {
        let unwrapped = tsrs_kernel::unwrap_expression(arg);
        if unwrapped == param_ident || !ast::is_identifier(unwrapped) {
            continue;
        }
        let Some(sym) = checker.get_symbol_at_location_exported(unwrapped) else {
            continue;
        };
        if sym.declarations().iter().copied().any(|decl| {
            decl.kind() == Kind::VariableDeclaration
                && tsrs_kernel::enclosing_function(decl) == Some(enclosing_fn)
        }) {
            return true;
        }
    }
    false
}

pub(super) fn forward_target_for_identifier(
    ident: P<Node>,
    sf: P<SourceFile>,
    checker: &mut Checker,
) -> Option<String> {
    let node = outer_expression(ident);
    if let Some(call) = forwarding_call_for_identifier(node) {
        if call_joins_local_variable(call, node, checker) {
            return None;
        }
        let callee = if ast::is_call_expression(call) {
            Some(call.as_call_expression().expression())
        } else if ast::is_new_expression(call) {
            Some(call.as_new_expression().expression())
        } else {
            None
        }?;
        if is_delegated_result_call(call) && is_first_party_layer_callee(callee, checker) {
            let text = tsrs_kernel::node_text(sf, callee).trim();
            return (!text.is_empty()).then(|| text.to_owned());
        }
        return None;
    }
    let tag_name = forwarding_jsx_tag_name_for_identifier(node)?;
    if is_first_party_layer_callee(tag_name, checker) {
        let text = tsrs_kernel::node_text(sf, tag_name).trim();
        return (!text.is_empty()).then(|| text.to_owned());
    }
    None
}
