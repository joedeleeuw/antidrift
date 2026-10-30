use antidrift_kernel::directives::split_identifier_words;
use antidrift_kernel::file_role;
use antidrift_kernel::provenance::{DeclarationOrigin, classify_source_file_origin};
use antidrift_kernel::shape;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};
use tsrslint::utils::is_object_type;

#[must_use]
pub fn has_modifier(node: P<Node>, flags: ModifierFlags) -> bool {
    ast::can_have_modifiers(node) && ast::get_combined_modifier_flags(node).intersects(flags)
}

fn build_structural_fork_message(subject: &str, owner: &str) -> RuleMessage {
    RuleMessage::new(
        "structuralTypeFork",
        format!(
            "'{subject}' restates the shape of '{owner}'. Import or derive (`Pick`/`Omit`/`Partial`) from '{owner}' instead of maintaining a parallel shape."
        ),
    )
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

fn shares_identifier_stem(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left_words = split_identifier_words(left);
    let right_words = split_identifier_words(right);
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
    if cand_type == owner_type
        || owner_type
            .symbol()
            .is_some_and(|sym| sym.declarations().contains(&cand_node))
        || owner_type
            .alias()
            .and_then(|alias| alias.symbol())
            .is_some_and(|sym| sym.declarations().contains(&cand_node))
    {
        return false;
    }
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
        if sf == ctx.file
            || file_role::ProjectPath::of(ctx.program, sf.file_name())
                .has_any_role(file_role::TEST_ROLES)
        {
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
    if file_role::is_declaration_file(file_name)
        || file_role::ProjectPath::of(ctx.program, file_name).has_any_role(file_role::TEST_ROLES)
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
