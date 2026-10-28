use antidrift_kernel::{boundary, shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, Node, NodeFlags, Symbol};
use tsrs_checker::{Checker, TypeFlags};
use tsrs_core::P;
use tsrslint::utils::is_type_flag_set;

pub fn assertion_parts(node: P<Node>) -> Option<(P<Node>, P<Node>)> {
    match node.kind() {
        Kind::AsExpression => {
            let as_expr = node.as_as_expression();
            Some((as_expr.expression(), as_expr.type_()))
        }
        Kind::TypeAssertionExpression => {
            let assertion = node.as_type_assertion();
            Some((assertion.expression(), assertion.type_()))
        }
        _ => None,
    }
}

pub fn is_const_assertion(type_node: P<Node>) -> bool {
    if type_node.kind() != Kind::TypeReference {
        return false;
    }
    let name = type_node.as_type_reference_node().type_name();
    ast::is_identifier(name) && name.as_identifier().text() == "const"
}

pub fn is_const_declaration(decl_node: P<Node>) -> bool {
    decl_node.parent().is_some_and(|parent| {
        parent.kind() == Kind::VariableDeclarationList
            && parent.flags().intersects(NodeFlags::Const)
    })
}

pub fn skip_parentheses_up(node: P<Node>) -> Option<P<Node>> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() != Kind::ParenthesizedExpression {
            return Some(parent);
        }
        current = parent.parent();
    }
    None
}

fn walk_nodes<F: FnMut(P<Node>)>(node: P<Node>, f: &mut F) {
    f(node);
    node.for_each_child(&mut |child| {
        walk_nodes(child, f);
        false
    });
}

fn skip_parenthesized_type(mut node: P<Node>) -> P<Node> {
    while node.kind() == Kind::ParenthesizedType {
        node = node.as_parenthesized_type_node().type_();
    }
    node
}

fn is_top_or_object_type_node(type_node: P<Node>) -> bool {
    matches!(
        skip_parenthesized_type(type_node).kind(),
        Kind::UnknownKeyword | Kind::AnyKeyword | Kind::ObjectKeyword
    )
}

pub fn classify_widening_target(type_node: P<Node>) -> Option<&'static str> {
    let node = skip_parenthesized_type(type_node);
    match node.kind() {
        Kind::UnknownKeyword => Some("unknown"),
        Kind::AnyKeyword => Some("any"),
        Kind::ObjectKeyword => Some("object"),
        Kind::TypeReference => {
            let tr = node.as_type_reference_node();
            let args = tr.type_arguments()?.nodes();
            (ast::is_identifier(tr.type_name())
                && tr.type_name().as_identifier().text() == "Record"
                && args.len() == 2
                && is_top_or_object_type_node(args[1]))
            .then_some("Record")
        }
        Kind::TypeLiteral => {
            let members = node.as_type_literal_node().members().nodes();
            if members.len() != 1 || members[0].kind() != Kind::IndexSignature {
                return None;
            }
            let sig = members[0].as_index_signature_declaration();
            is_top_or_object_type_node(sig.type_()?).then_some("index-signature")
        }
        _ => None,
    }
}

pub fn is_empty_container_literal(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_parentheses(node);
    match unwrapped.kind() {
        Kind::ObjectLiteralExpression => unwrapped
            .as_object_literal_expression()
            .properties()
            .nodes()
            .is_empty(),
        Kind::ArrayLiteralExpression => unwrapped
            .as_array_literal_expression()
            .elements()
            .nodes()
            .is_empty(),
        _ => false,
    }
}

fn is_object_freeze_callee(callee: P<Node>) -> bool {
    if callee.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let prop = callee.as_property_access_expression();
    let obj = tsrs_kernel::unwrap_parentheses(prop.expression());
    ast::is_identifier(obj)
        && obj.as_identifier().text() == "Object"
        && ast::is_identifier(prop.name())
        && prop.name().as_identifier().text() == "freeze"
}

fn is_known_call_expression(checker: &mut Checker, call_node: P<Node>) -> bool {
    let call = call_node.as_call_expression();
    let callee = tsrs_kernel::unwrap_parentheses(call.expression());
    if is_object_freeze_callee(callee) {
        return call
            .arguments()
            .nodes()
            .first()
            .is_some_and(|&arg| is_known_value_expression(checker, arg));
    }
    let Some(decl) = checker
        .get_symbol_at_location_exported(callee)
        .and_then(|sym| sym.value_declaration())
    else {
        return false;
    };
    if !matches!(
        decl.kind(),
        Kind::FunctionDeclaration
            | Kind::FunctionExpression
            | Kind::ArrowFunction
            | Kind::MethodDeclaration
            | Kind::VariableDeclaration
    ) {
        return false;
    }
    let call_type = checker.get_type_at_location(call_node);
    shape::is_specific_type(call_type)
}

fn is_known_identifier(checker: &mut Checker, ident: P<Node>) -> bool {
    let Some(decl) = checker
        .get_symbol_at_location_exported(ident)
        .and_then(|sym| sym.value_declaration())
    else {
        return false;
    };
    if decl.kind() != Kind::VariableDeclaration || !is_const_declaration(decl) {
        return false;
    }
    let vd = decl.as_variable_declaration();
    if vd.type_().and_then(classify_widening_target).is_some() {
        return false;
    }
    vd.initializer()
        .is_some_and(|init| is_known_value_expression(checker, init))
}

pub fn is_known_value_expression(checker: &mut Checker, expr: P<Node>) -> bool {
    let node = tsrs_kernel::unwrap_parentheses(expr);
    if is_empty_container_literal(node) {
        return false;
    }
    match node.kind() {
        Kind::ObjectLiteralExpression
        | Kind::ArrayLiteralExpression
        | Kind::StringLiteral
        | Kind::NoSubstitutionTemplateLiteral
        | Kind::TemplateExpression
        | Kind::NumericLiteral
        | Kind::BigIntLiteral
        | Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::ArrowFunction
        | Kind::FunctionExpression
        | Kind::ClassExpression => true,
        Kind::PrefixUnaryExpression => {
            is_known_value_expression(checker, node.as_prefix_unary_expression().operand())
        }
        Kind::BinaryExpression => {
            let bin = node.as_binary_expression();
            is_known_value_expression(checker, bin.left())
                && is_known_value_expression(checker, bin.right())
        }
        Kind::SatisfiesExpression => {
            is_known_value_expression(checker, node.as_satisfies_expression().expression())
        }
        Kind::AsExpression | Kind::TypeAssertionExpression => assertion_parts(node)
            .is_some_and(|(op, t)| is_const_assertion(t) && is_known_value_expression(checker, op)),
        Kind::NewExpression => {
            let typ = checker.get_type_at_location(node);
            !is_type_flag_set(typ, TypeFlags::AnyOrUnknown)
        }
        Kind::CallExpression => is_known_call_expression(checker, node),
        Kind::Identifier => is_known_identifier(checker, node),
        _ => false,
    }
}

pub fn is_populated_case_table_object(init: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(init);
    let candidate = if unwrapped.kind() == Kind::CallExpression
        && let Some(&first) = unwrapped.as_call_expression().arguments().nodes().first()
    {
        tsrs_kernel::unwrap_expression(first)
    } else {
        unwrapped
    };
    candidate.kind() == Kind::ObjectLiteralExpression
        && !candidate
            .as_object_literal_expression()
            .properties()
            .nodes()
            .is_empty()
}

fn is_member_of_symbol(checker: &mut Checker, expr: P<Node>, target_sym: P<Symbol>) -> bool {
    let mut current = tsrs_kernel::unwrap_parentheses(expr);
    let mut saw_member = false;
    while matches!(
        current.kind(),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression
    ) {
        saw_member = true;
        current = if current.kind() == Kind::PropertyAccessExpression {
            tsrs_kernel::unwrap_parentheses(current.as_property_access_expression().expression())
        } else {
            tsrs_kernel::unwrap_parentheses(current.as_element_access_expression().expression())
        };
    }
    saw_member
        && ast::is_identifier(current)
        && checker.get_symbol_at_location_exported(current) == Some(target_sym)
}

fn mutates_symbol(checker: &mut Checker, node: P<Node>, target_sym: P<Symbol>) -> bool {
    if node.kind() == Kind::BinaryExpression {
        let bin = node.as_binary_expression();
        return bin.operator_token().kind() == Kind::EqualsToken
            && is_member_of_symbol(checker, bin.left(), target_sym);
    }
    if node.kind() == Kind::DeleteExpression {
        return is_member_of_symbol(
            checker,
            node.as_delete_expression().expression(),
            target_sym,
        );
    }
    false
}

pub fn is_mutated_object_binding(
    checker: &mut Checker,
    root: P<Node>,
    target_sym: P<Symbol>,
) -> bool {
    let mut mutated = false;
    walk_nodes(root, &mut |node| {
        if !mutated && mutates_symbol(checker, node, target_sym) {
            mutated = true;
        }
    });
    mutated
}

pub fn erased_unknown_source(type_node: Option<P<Node>>, init: P<Node>) -> Option<P<Node>> {
    let unwrapped_init = tsrs_kernel::unwrap_parentheses(init);
    if let Some((operand, cast_type)) = assertion_parts(unwrapped_init)
        && cast_type.kind() == Kind::UnknownKeyword
    {
        return Some(tsrs_kernel::unwrap_parentheses(operand));
    }
    type_node
        .is_some_and(|ann| ann.kind() == Kind::UnknownKeyword)
        .then_some(unwrapped_init)
}

fn is_laundered_reference(checker: &mut Checker, node: P<Node>) -> bool {
    let Some(parent) = skip_parentheses_up(node) else {
        return false;
    };
    if parent.kind() == Kind::CallExpression {
        return boundary::schema_validation_call_parts(parent, checker)
            .is_some_and(|parts| tsrs_kernel::unwrap_parentheses(parts.arg_node) == node);
    }
    assertion_parts(parent).is_some_and(|(_, t)| t.kind() == Kind::TypeReference)
}

pub fn has_laundered_unknown_use(
    checker: &mut Checker,
    root: P<Node>,
    target_sym: P<Symbol>,
    decl_name: P<Node>,
) -> bool {
    let mut found = false;
    walk_nodes(root, &mut |node| {
        if !found
            && node != decl_name
            && ast::is_identifier(node)
            && checker.get_symbol_at_location_exported(node) == Some(target_sym)
            && is_laundered_reference(checker, node)
        {
            found = true;
        }
    });
    found
}

pub fn is_widened_known_declaration(checker: &mut Checker, decl_node: P<Node>) -> bool {
    let decl = decl_node.as_variable_declaration();
    let Some(init) = decl.initializer() else {
        return false;
    };
    let unwrapped_init = tsrs_kernel::unwrap_parentheses(init);
    if let Some((operand, cast_type)) = assertion_parts(unwrapped_init)
        && classify_widening_target(cast_type).is_some()
    {
        return is_known_value_expression(checker, operand);
    }
    decl.type_().and_then(classify_widening_target).is_some()
        && is_known_value_expression(checker, unwrapped_init)
}
