use super::structural_fork_analysis::has_modifier;
use antidrift_kernel::rule::{Ctx, RuleMessage};
use antidrift_kernel::tsrs_kernel;
use tsrs_ast::{Kind, ModifierFlags, Node, NodeFlags, SourceFile};
use tsrs_core::P;

fn build_redundant_return_message(fn_name: &str, type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "redundantLocalReturnType",
        format!(
            "Local helper '{fn_name}' declares one-use return type '{type_name}' that restates its returned object literal inside an explicitly typed enclosing function. Remove the local type alias and return annotation; let TypeScript infer the helper return and check it against the enclosing return contract."
        ),
    )
}

fn extract_shorthand_keys(obj: P<Node>) -> Option<Vec<String>> {
    if obj.kind() != Kind::ObjectLiteralExpression {
        return None;
    }
    let props = obj.as_object_literal_expression().properties().nodes();
    if props.is_empty() {
        return None;
    }
    let mut names = Vec::with_capacity(props.len());
    for &prop in props {
        if prop.kind() != Kind::ShorthandPropertyAssignment {
            return None;
        }
        let name_node = prop.as_shorthand_property_assignment().name();
        if name_node.kind() != Kind::Identifier {
            return None;
        }
        names.push(name_node.as_identifier().text().to_owned());
    }
    Some(names)
}

fn returned_shorthand_object_keys(fn_node: P<Node>) -> Option<Vec<String>> {
    let body = fn_node.body()?;
    if body.kind() != Kind::Block {
        return extract_shorthand_keys(tsrs_kernel::unwrap_expression(body));
    }
    let stmts = body.as_block().statements().nodes();
    if stmts.len() != 1 || stmts[0].kind() != Kind::ReturnStatement {
        return None;
    }
    let expr = stmts[0].as_return_statement().expression()?;
    extract_shorthand_keys(tsrs_kernel::unwrap_expression(expr))
}

fn matches_local_type_alias(stmt: P<Node>, alias_name: &str) -> bool {
    if stmt.kind() != Kind::TypeAliasDeclaration {
        return false;
    }
    let alias = stmt.as_type_alias_declaration();
    alias.name().kind() == Kind::Identifier && alias.name().as_identifier().text() == alias_name
}

fn extract_mutable_required_literal_fields(type_node: P<Node>) -> Option<Vec<String>> {
    if type_node.kind() != Kind::TypeLiteral {
        return None;
    }
    let members = type_node.as_type_literal_node().members().nodes();
    let mut names = Vec::with_capacity(members.len());
    for &member in members {
        if member.kind() != Kind::PropertySignature || has_modifier(member, ModifierFlags::Readonly)
        {
            return None;
        }
        let prop = member.as_property_signature_declaration();
        if prop.postfix_token().is_some() || prop.name().kind() != Kind::Identifier {
            return None;
        }
        names.push(prop.name().as_identifier().text().to_owned());
    }
    Some(names)
}

fn find_local_type_alias_fields(sf: P<SourceFile>, alias_name: &str) -> Option<Vec<String>> {
    let matching: Vec<P<Node>> = sf
        .statements()
        .nodes()
        .iter()
        .copied()
        .filter(|&stmt| matches_local_type_alias(stmt, alias_name))
        .collect();
    if matching.len() != 1 {
        return None;
    }
    let alias_stmt = matching[0];
    let alias = alias_stmt.as_type_alias_declaration();
    if has_modifier(alias_stmt, ModifierFlags::Export)
        || alias
            .type_parameters()
            .is_some_and(|tp| !tp.nodes().is_empty())
    {
        return None;
    }
    extract_mutable_required_literal_fields(alias.type_()?)
}

fn count_identifier_occurrences(root: P<Node>, target: &str) -> usize {
    let mut count =
        usize::from(root.kind() == Kind::Identifier && root.as_identifier().text() == target);
    root.for_each_child(&mut |child| {
        count += count_identifier_occurrences(child, target);
        false
    });
    count
}

fn is_call_in_return_statement(call_node: P<Node>) -> bool {
    let mut parent = call_node.parent();
    while let Some(curr) = parent {
        if curr.kind() != Kind::ParenthesizedExpression {
            return curr.kind() == Kind::ReturnStatement;
        }
        parent = curr.parent();
    }
    false
}

fn inspect_helper_call_node(
    node: P<Node>,
    helper_name: &str,
    call_count: &mut usize,
    non_return_call: &mut bool,
) {
    if node.kind() != Kind::CallExpression {
        return;
    }
    let callee = node.as_call_expression().expression();
    if callee.kind() == Kind::Identifier && callee.as_identifier().text() == helper_name {
        *call_count += 1;
        if !is_call_in_return_statement(node) {
            *non_return_call = true;
        }
    }
}

fn walk_helper_calls(
    node: P<Node>,
    enclosing_fn: P<Node>,
    helper_name: &str,
    call_count: &mut usize,
    non_return_call: &mut bool,
) {
    if node != enclosing_fn && tsrs_kernel::is_function_like(node) {
        return;
    }
    inspect_helper_call_node(node, helper_name, call_count, non_return_call);
    node.for_each_child(&mut |child| {
        walk_helper_calls(
            child,
            enclosing_fn,
            helper_name,
            call_count,
            non_return_call,
        );
        false
    });
}

fn all_helper_calls_in_return(enclosing_fn: P<Node>, helper_name: &str) -> bool {
    let mut call_count = 0usize;
    let mut non_return_call = false;
    walk_helper_calls(
        enclosing_fn,
        enclosing_fn,
        helper_name,
        &mut call_count,
        &mut non_return_call,
    );
    call_count > 0 && !non_return_call
}

fn extract_local_helper_candidate(node: P<Node>) -> Option<(P<Node>, &'static str)> {
    match node.kind() {
        Kind::FunctionDeclaration => {
            if has_modifier(node, ModifierFlags::Export) {
                return None;
            }
            let name_node = node.as_function_declaration().name()?;
            (name_node.kind() == Kind::Identifier).then(|| (node, name_node.as_identifier().text()))
        }
        Kind::VariableDeclaration => {
            let var_decl = node.as_variable_declaration();
            if var_decl.name().kind() != Kind::Identifier {
                return None;
            }
            let parent = node.parent()?;
            if parent.kind() != Kind::VariableDeclarationList
                || !parent.flags().intersects(NodeFlags::Const)
            {
                return None;
            }
            if parent
                .parent()
                .is_some_and(|gp| has_modifier(gp, ModifierFlags::Export))
            {
                return None;
            }
            let init = var_decl.initializer()?;
            matches!(init.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                .then(|| (init, var_decl.name().as_identifier().text()))
        }
        _ => None,
    }
}

pub fn check_redundant_local_return(ctx: &mut Ctx, node: P<Node>) {
    let Some((fn_node, fn_name)) = extract_local_helper_candidate(node) else {
        return;
    };
    if has_modifier(fn_node, ModifierFlags::Async)
        || tsrs_kernel::is_generator_function(fn_node)
        || !fn_node.type_parameters().is_empty()
    {
        return;
    }
    let Some(enclosing_fn) = tsrs_kernel::enclosing_function(node) else {
        return;
    };
    if tsrs_kernel::function_return_type_node(enclosing_fn).is_none() {
        return;
    }
    let Some(ret_type_node) = tsrs_kernel::function_return_type_node(fn_node) else {
        return;
    };
    if ret_type_node.kind() != Kind::TypeReference {
        return;
    }
    let type_ref = ret_type_node.as_type_reference_node();
    if type_ref
        .type_arguments()
        .is_some_and(|ta| !ta.nodes().is_empty())
        || type_ref.type_name().kind() != Kind::Identifier
    {
        return;
    }
    let alias_name = type_ref.type_name().as_identifier().text();
    let Some(mut obj_keys) = returned_shorthand_object_keys(fn_node) else {
        return;
    };
    let Some(mut alias_keys) = find_local_type_alias_fields(ctx.file, alias_name) else {
        return;
    };
    obj_keys.sort();
    alias_keys.sort();
    if obj_keys == alias_keys
        && count_identifier_occurrences(ctx.file.as_node(), alias_name) == 2
        && all_helper_calls_in_return(enclosing_fn, fn_name)
    {
        ctx.report_node(
            ret_type_node,
            build_redundant_return_message(fn_name, alias_name),
        );
    }
}

fn prop_access_pair(node: P<Node>) -> Option<(P<Node>, &'static str)> {
    let inner = tsrs_kernel::unwrap_expression(node);
    if inner.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let pa = inner.as_property_access_expression();
    let name = pa.name();
    (name.kind() == Kind::Identifier).then(|| {
        (
            tsrs_kernel::unwrap_expression(pa.expression()),
            name.as_identifier().text(),
        )
    })
}

fn call_decoded_doc_field(call_node: P<Node>, doc_name: &str) -> Option<&'static str> {
    let inner = tsrs_kernel::unwrap_expression(call_node);
    if inner.kind() != Kind::CallExpression {
        return None;
    }
    let &arg = inner.as_call_expression().arguments().nodes().first()?;
    let (recv, field) = prop_access_pair(arg)?;
    (recv.kind() == Kind::Identifier && recv.as_identifier().text() == doc_name).then_some(field)
}

fn find_var_init(root: P<Node>, target: &str) -> Option<P<Node>> {
    if root.kind() == Kind::VariableDeclaration {
        let decl = root.as_variable_declaration();
        if decl.name().kind() == Kind::Identifier && decl.name().as_identifier().text() == target {
            return decl.initializer();
        }
    }
    let mut found = None;
    root.for_each_child(&mut |child| {
        if found.is_none() {
            found = find_var_init(child, target);
        }
        found.is_some()
    });
    found
}

fn resolve_decoded_blob_field(
    scope: P<Node>,
    candidate_recv: P<Node>,
    doc_recv: P<Node>,
    shared_field: &str,
) -> Option<(&'static str, &'static str)> {
    if doc_recv.kind() != Kind::Identifier {
        return None;
    }
    let doc_name = doc_recv.as_identifier().text();
    let blob_field = if candidate_recv.kind() == Kind::CallExpression {
        call_decoded_doc_field(candidate_recv, doc_name)?
    } else if candidate_recv.kind() == Kind::Identifier {
        let init = find_var_init(scope, candidate_recv.as_identifier().text())?;
        call_decoded_doc_field(init, doc_name)?
    } else {
        return None;
    };
    (blob_field != shared_field).then_some((doc_name, blob_field))
}

pub fn check_decoded_blob_sibling_equality(ctx: &mut Ctx, node: P<Node>) {
    let bin = node.as_binary_expression();
    if !matches!(
        bin.operator_token().kind(),
        Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken
    ) {
        return;
    }
    let (Some((left_recv, left_field)), Some((right_recv, right_field))) =
        (prop_access_pair(bin.left()), prop_access_pair(bin.right()))
    else {
        return;
    };
    if left_field != right_field {
        return;
    }
    let scope = tsrs_kernel::enclosing_function(node).unwrap_or_else(|| ctx.file.as_node());
    let matched = resolve_decoded_blob_field(scope, left_recv, right_recv, left_field)
        .or_else(|| resolve_decoded_blob_field(scope, right_recv, left_recv, left_field));
    if let Some((doc_name, blob_field)) = matched {
        ctx.report_node(
            node,
            RuleMessage::new(
                "decodedBlobSiblingEquality",
                format!(
                    "Decoded blob field '{left_field}' is compared against sibling property '{doc_name}.{left_field}' on the same record; keep one canonical owner instead of duplicating columns beside '{doc_name}.{blob_field}'."
                ),
            ),
        );
    }
}

fn is_constant_literal_expr(node: P<Node>) -> bool {
    let inner = tsrs_kernel::unwrap_expression(node);
    match inner.kind() {
        Kind::StringLiteral
        | Kind::NumericLiteral
        | Kind::NoSubstitutionTemplateLiteral
        | Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::NullKeyword => true,
        Kind::PrefixUnaryExpression => {
            is_constant_literal_expr(inner.as_prefix_unary_expression().operand())
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            is_constant_literal_expr(bin.left()) && is_constant_literal_expr(bin.right())
        }
        _ => false,
    }
}

fn constant_object_signature(sf: P<SourceFile>, obj: P<Node>) -> Option<String> {
    if obj
        .parent()
        .is_some_and(|p| p.kind() == Kind::ArrayLiteralExpression)
    {
        return None;
    }
    let mut entries: Vec<String> = obj
        .as_object_literal_expression()
        .properties()
        .nodes()
        .iter()
        .filter_map(|&prop| {
            let pa =
                (prop.kind() == Kind::PropertyAssignment).then(|| prop.as_property_assignment())?;
            (pa.name().kind() == Kind::Identifier && is_constant_literal_expr(pa.initializer()))
                .then(|| {
                    let k = pa.name().as_identifier().text();
                    let v = tsrs_kernel::node_text(sf, pa.initializer())
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join("");
                    format!("{k}={v}")
                })
        })
        .collect();
    if entries.len() < 3 {
        return None;
    }
    entries.sort();
    Some(entries.join(";"))
}

fn collect_constant_objects(
    sf: P<SourceFile>,
    node: P<Node>,
    groups: &mut std::collections::BTreeMap<String, Vec<P<Node>>>,
) {
    if node.kind() == Kind::ObjectLiteralExpression
        && let Some(sig) = constant_object_signature(sf, node)
    {
        groups.entry(sig).or_default().push(node);
    }
    node.for_each_child(&mut |child| {
        collect_constant_objects(sf, child, groups);
        false
    });
}

pub fn check_repeated_object_literals(ctx: &mut Ctx) {
    let mut groups = std::collections::BTreeMap::new();
    collect_constant_objects(ctx.file, ctx.file.as_node(), &mut groups);
    for nodes in groups.into_values() {
        if nodes.len() >= 3 {
            ctx.report_node(
                nodes[0],
                RuleMessage::new(
                    "repeatedObjectLiteral",
                    format!(
                        "Identical constant object literal is repeated {} times in this module; extract a shared constant and reuse or spread it.",
                        nodes.len()
                    ),
                ),
            );
        }
    }
}
