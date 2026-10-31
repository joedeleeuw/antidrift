use std::borrow::Cow;
use std::cell::RefCell;
use std::thread::LocalKey;

use antidrift_kernel::directives::split_identifier_words;
use antidrift_kernel::file_role;
use antidrift_kernel::program_fact::{ProgramFact, ProgramFactSlot};
use antidrift_kernel::provenance::{DeclarationOrigin, classify_source_file_origin};
use antidrift_kernel::shape;
use tsrs_ast::{self as ast, Kind, ModifierFlags, Node, SourceFile};
use tsrs_checker::Checker;
use tsrs_compiler::Program;
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

enum OwnerMembers {
    Declared(Vec<String>),
    Resolved,
}

struct OwnerDeclaration {
    statement: P<Node>,
    name: String,
    members: OwnerMembers,
}

struct OwnerFile {
    file: P<SourceFile>,
    origin: DeclarationOrigin,
    declarations: Vec<OwnerDeclaration>,
}

struct ExportedOwnerIndex {
    files: Vec<OwnerFile>,
}

thread_local! {
    static OWNER_INDEX: ProgramFactSlot<ExportedOwnerIndex> = const { RefCell::new(None) };
}

fn owner_declaration(statement: P<Node>) -> Option<OwnerDeclaration> {
    if !has_modifier(statement, ModifierFlags::Export) {
        return None;
    }
    if let Some((name, members)) = plain_declaration_member_names(statement) {
        return Some(OwnerDeclaration {
            statement,
            name,
            members: OwnerMembers::Declared(members),
        });
    }
    if statement.kind() != Kind::TypeAliasDeclaration {
        return None;
    }
    let alias = statement.as_type_alias_declaration();
    if alias
        .type_parameters()
        .is_some_and(|tp| !tp.nodes().is_empty())
        || alias.name().kind() != Kind::Identifier
    {
        return None;
    }
    Some(OwnerDeclaration {
        statement,
        name: alias.name().as_identifier().text().to_owned(),
        members: OwnerMembers::Resolved,
    })
}

fn index_owner_files(program: &Program) -> Vec<OwnerFile> {
    program
        .get_source_files()
        .iter()
        .filter_map(|&sf| {
            if file_role::ProjectPath::of(program, sf.file_name())
                .has_any_role(file_role::TEST_ROLES)
            {
                return None;
            }
            let origin = classify_source_file_origin(program, sf, None);
            if matches!(
                origin,
                DeclarationOrigin::DefaultLib | DeclarationOrigin::Unknown
            ) {
                return None;
            }
            let declarations: Vec<OwnerDeclaration> = sf
                .statements()
                .nodes()
                .iter()
                .filter_map(|&statement| owner_declaration(statement))
                .collect();
            (!declarations.is_empty()).then_some(OwnerFile {
                file: sf,
                origin,
                declarations,
            })
        })
        .collect()
}

impl ProgramFact for ExportedOwnerIndex {
    fn slot() -> &'static LocalKey<ProgramFactSlot<Self>> {
        &OWNER_INDEX
    }

    fn build(program: &Program) -> Self {
        Self {
            files: index_owner_files(program),
        }
    }
}

fn resolved_owner_member_names(checker: &mut Checker, statement: P<Node>) -> Option<Vec<String>> {
    let owner_type = checker.get_type_at_location(statement);
    if !is_object_type(owner_type)
        || checker.is_array_type(owner_type)
        || tsrs_checker::is_tuple_type_exported(owner_type)
        || shape::has_string_or_number_index_signature(checker, owner_type)
    {
        return None;
    }
    let names = shape::object_property_names(checker, owner_type);
    (names.len() >= 2).then_some(names)
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

fn find_owner_in_file(
    checker: &mut Checker,
    owner_file: &OwnerFile,
    is_accepted_authority: bool,
    cand_node: P<Node>,
    cand_name: &str,
    cand_props: &[String],
) -> Option<String> {
    let cand_exported = has_modifier(cand_node, ModifierFlags::Export);
    for declaration in &owner_file.declarations {
        let owner_props: Cow<'_, [String]> = match &declaration.members {
            OwnerMembers::Declared(members) => Cow::Borrowed(members),
            OwnerMembers::Resolved => {
                match resolved_owner_member_names(checker, declaration.statement) {
                    Some(members) => Cow::Owned(members),
                    None => continue,
                }
            }
        };
        if *owner_props != *cand_props {
            continue;
        }
        let owner_name = &declaration.name;
        let authority_match = is_accepted_authority
            && (cand_props.len() >= 3
                || !cand_exported
                || shares_identifier_stem(cand_name, owner_name));
        if (authority_match || owner_name == cand_name)
            && has_exact_same_property_types(checker, cand_node, declaration.statement, cand_props)
        {
            return Some(owner_name.clone());
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
    let index = ExportedOwnerIndex::for_program(ctx.program);
    for owner_file in &index.files {
        if owner_file.file == ctx.file {
            continue;
        }
        let origin = owner_file.origin;
        if file_origin == DeclarationOrigin::LocalDomain
            && origin == DeclarationOrigin::LocalDomain
            && cand_exported
            && owner_file.file.file_name() > ctx.file.file_name()
        {
            continue;
        }
        let is_accepted_authority = origin == DeclarationOrigin::Generated
            || (origin == DeclarationOrigin::LocalDomain
                && (file_origin != DeclarationOrigin::LocalDomain || !cand_exported));
        if let Some(owner_name) = find_owner_in_file(
            ctx.checker,
            owner_file,
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
