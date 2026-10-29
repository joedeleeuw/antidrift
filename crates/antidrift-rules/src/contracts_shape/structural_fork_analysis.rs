use antidrift_kernel::provenance::{DeclarationOrigin, classify_source_file_origin};
use antidrift_kernel::{shape, tsrs_kernel};
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, NodeFlags, SourceFile};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};
use tsrslint::utils::is_object_type;

#[must_use]
pub fn has_modifier(node: P<Node>, flags: ModifierFlags) -> bool {
    ast::can_have_modifiers(node) && ast::get_combined_modifier_flags(node).intersects(flags)
}

fn build_redundant_return_message(fn_name: &str, type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "redundantLocalReturnType",
        format!(
            "Local helper '{fn_name}' declares one-use return type '{type_name}' that restates its returned object literal inside an explicitly typed enclosing function. Remove the local type alias and return annotation; let TypeScript infer the helper return and check it against the enclosing return contract."
        ),
    )
}

fn build_structural_fork_message(subject: &str, owner: &str) -> RuleMessage {
    RuleMessage::new(
        "structuralTypeFork",
        format!(
            "'{subject}' restates the shape of '{owner}'. Import or derive (`Pick`/`Omit`/`Partial`) from '{owner}' instead of maintaining a parallel shape."
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

fn sorted_property_signature_names(members: &[P<Node>]) -> Option<Vec<String>> {
    if members.len() < 2 {
        return None;
    }
    let mut names = Vec::with_capacity(members.len());
    for &m in members {
        if m.kind() != Kind::PropertySignature {
            return None;
        }
        let p = m.as_property_signature_declaration();
        if p.name().kind() != Kind::Identifier {
            return None;
        }
        names.push(p.name().as_identifier().text().to_owned());
    }
    names.sort();
    Some(names)
}

fn plain_declaration_member_names(node: P<Node>) -> Option<(String, Vec<String>)> {
    match node.kind() {
        Kind::InterfaceDeclaration => {
            let iface = node.as_interface_declaration();
            if iface
                .type_parameters()
                .is_some_and(|tp| !tp.nodes().is_empty())
                || iface
                    .heritage_clauses()
                    .is_some_and(|hc| !hc.nodes().is_empty())
                || iface.name().kind() != Kind::Identifier
            {
                return None;
            }
            let names = sorted_property_signature_names(iface.members().nodes())?;
            Some((iface.name().as_identifier().text().to_owned(), names))
        }
        Kind::TypeAliasDeclaration => {
            let alias = node.as_type_alias_declaration();
            if alias
                .type_parameters()
                .is_some_and(|tp| !tp.nodes().is_empty())
                || alias.name().kind() != Kind::Identifier
            {
                return None;
            }
            let type_node = alias.type_()?;
            if type_node.kind() != Kind::TypeLiteral {
                return None;
            }
            let names = sorted_property_signature_names(
                type_node.as_type_literal_node().members().nodes(),
            )?;
            Some((alias.name().as_identifier().text().to_owned(), names))
        }
        _ => None,
    }
}

fn exported_owner_member_names(
    checker: &mut Checker,
    node: P<Node>,
) -> Option<(String, Vec<String>)> {
    if let Some(plain) = plain_declaration_member_names(node) {
        return Some(plain);
    }
    if node.kind() != Kind::TypeAliasDeclaration {
        return None;
    }
    let alias = node.as_type_alias_declaration();
    if alias
        .type_parameters()
        .is_some_and(|tp| !tp.nodes().is_empty())
        || alias.name().kind() != Kind::Identifier
    {
        return None;
    }
    let owner_type = checker.get_type_at_location(node);
    if !is_object_type(owner_type)
        || checker.is_array_type(owner_type)
        || tsrs_checker::is_tuple_type_exported(owner_type)
        || shape::has_string_or_number_index_signature(checker, owner_type)
    {
        return None;
    }
    let names = shape::object_property_names(checker, owner_type);
    (names.len() >= 2).then(|| (alias.name().as_identifier().text().to_owned(), names))
}

fn identifier_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in name.chars() {
        if !ch.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        if ch.is_uppercase() && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn shares_identifier_stem(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left_words = identifier_words(left);
    let right_words = identifier_words(right);
    left_words
        .iter()
        .any(|lw| lw.len() >= 3 && right_words.iter().any(|rw| rw == lw))
}

fn has_exact_same_property_types(
    checker: &mut Checker,
    cand_node: P<Node>,
    owner_node: P<Node>,
    prop_names: &[String],
) -> bool {
    let cand_type = checker.get_type_at_location(cand_node);
    let owner_type = checker.get_type_at_location(owner_node);
    prop_names.iter().all(|name| {
        let Some(cand_sym) = checker.get_property_of_type_exported(cand_type, name) else {
            return false;
        };
        let Some(owner_sym) = checker.get_property_of_type_exported(owner_type, name) else {
            return false;
        };
        let Some(cand_prop) = checker.get_type_of_symbol_at_location(cand_sym, Some(cand_node))
        else {
            return false;
        };
        let Some(owner_prop) = checker.get_type_of_symbol_at_location(owner_sym, Some(owner_node))
        else {
            return false;
        };
        checker.is_type_assignable_to(cand_prop, owner_prop)
            && checker.is_type_assignable_to(owner_prop, cand_prop)
    })
}

fn find_owner_in_source_file(
    checker: &mut Checker,
    sf: P<SourceFile>,
    is_accepted_authority: bool,
    cand_node: P<Node>,
    cand_name: &str,
    cand_props: &[String],
) -> Option<String> {
    let cand_exported = has_modifier(cand_node, ModifierFlags::Export);
    for &stmt in sf.statements().nodes() {
        if !has_modifier(stmt, ModifierFlags::Export) {
            continue;
        }
        let Some((owner_name, owner_props)) = exported_owner_member_names(checker, stmt) else {
            continue;
        };
        let authority_match = is_accepted_authority
            && (cand_props.len() >= 3
                || !cand_exported
                || shares_identifier_stem(cand_name, &owner_name));
        if owner_props == cand_props
            && (authority_match || owner_name == cand_name)
            && has_exact_same_property_types(checker, cand_node, stmt, cand_props)
        {
            return Some(owner_name);
        }
    }
    None
}

fn find_matching_exported_owner(
    ctx: &mut Ctx,
    file_origin: DeclarationOrigin,
    cand_node: P<Node>,
    cand_name: &str,
    cand_props: &[String],
) -> Option<String> {
    let cand_exported = has_modifier(cand_node, ModifierFlags::Export);
    for &sf in ctx.program.get_source_files() {
        if sf == ctx.file || tsrs_kernel::is_test_file(sf.file_name()) {
            continue;
        }
        let origin = classify_source_file_origin(ctx.program, sf, Some(ctx.file));
        if matches!(
            origin,
            DeclarationOrigin::DefaultLib
                | DeclarationOrigin::SameFile
                | DeclarationOrigin::Unknown
        ) {
            continue;
        }
        if file_origin == DeclarationOrigin::LocalDomain
            && origin == DeclarationOrigin::LocalDomain
            && cand_exported
            && sf.file_name() > ctx.file.file_name()
        {
            continue;
        }
        let is_accepted_authority = origin == DeclarationOrigin::Generated
            || (origin == DeclarationOrigin::LocalDomain
                && (file_origin != DeclarationOrigin::LocalDomain || !cand_exported));
        if let Some(owner_name) = find_owner_in_source_file(
            ctx.checker,
            sf,
            is_accepted_authority,
            cand_node,
            cand_name,
            cand_props,
        ) {
            return Some(owner_name);
        }
    }
    None
}

pub fn check_structural_fork_declaration(ctx: &mut Ctx, node: P<Node>) {
    let file_name = ctx.file.file_name();
    let file_origin = classify_source_file_origin(ctx.program, ctx.file, None);
    if tsrs_kernel::is_declaration_file(file_name)
        || tsrs_kernel::is_test_file(file_name)
        || matches!(
            file_origin,
            DeclarationOrigin::DefaultLib
                | DeclarationOrigin::NodeModules
                | DeclarationOrigin::Generated
        )
    {
        return;
    }
    let Some((cand_name, cand_props)) = plain_declaration_member_names(node) else {
        return;
    };
    if let Some(owner_name) =
        find_matching_exported_owner(ctx, file_origin, node, &cand_name, &cand_props)
    {
        ctx.report_node(node, build_structural_fork_message(&cand_name, &owner_name));
    }
}
