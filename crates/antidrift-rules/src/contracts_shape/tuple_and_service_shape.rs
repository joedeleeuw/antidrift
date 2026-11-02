use antidrift_kernel::directives::split_identifier_words;
use antidrift_kernel::file_role;
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use antidrift_kernel::tsrs_kernel::cooked_text;
use antidrift_kernel::{boundary, provenance};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile, Symbol};
use tsrs_checker::{Checker, Type, TypeFlags};
use tsrs_core::P;

const TUPLE_LISTENERS: &[Listener] = &[Listener::Enter(Kind::TupleType)];
const IMPORT_LISTENERS: &[Listener] = &[Listener::Enter(Kind::ImportDeclaration)];

pub static NO_NULLABLE_POSITIONAL_TUPLE: RuleSpec = RuleSpec::new(
    "antidrift/no-nullable-positional-tuple",
    TUPLE_LISTENERS,
    visit_nullable_positional_tuple,
);

pub static NO_SERVICE_CONSTRUCTOR_IMPORTS: RuleSpec = RuleSpec::new(
    "antidrift/no-service-constructor-imports",
    IMPORT_LISTENERS,
    visit_service_constructor_imports,
);

fn build_nullable_positional_tuple_message() -> RuleMessage {
    RuleMessage::new(
        "nullablePositionalTuple",
        "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
    )
}

fn tuple_element_is_optional(element: P<Node>) -> bool {
    match element.kind() {
        Kind::OptionalType => true,
        Kind::NamedTupleMember => {
            let member = element.as_named_tuple_member();
            member.question_token().is_some() || member.type_().kind() == Kind::OptionalType
        }
        _ => false,
    }
}

fn tuple_element_type_node(element: P<Node>) -> P<Node> {
    match element.kind() {
        Kind::NamedTupleMember => tuple_element_type_node(element.as_named_tuple_member().type_()),
        Kind::OptionalType => element.as_optional_type_node().type_(),
        Kind::RestType => element.as_rest_type_node().type_(),
        _ => element,
    }
}

fn type_node_includes_direct_nullish(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::NullKeyword | Kind::UndefinedKeyword | Kind::VoidKeyword => true,
        Kind::LiteralType => type_node.as_literal_type_node().literal().kind() == Kind::NullKeyword,
        Kind::UnionType => type_node
            .as_union_type_node()
            .types()
            .nodes()
            .iter()
            .copied()
            .any(type_node_includes_direct_nullish),
        Kind::ParenthesizedType => {
            type_node_includes_direct_nullish(type_node.as_parenthesized_type_node().type_())
        }
        _ => false,
    }
}

fn type_includes_null_or_undefined(typ: P<Type>, seen: &mut FxHashSet<P<Type>>) -> bool {
    if !seen.insert(typ) {
        return false;
    }
    if typ
        .flags()
        .intersects(TypeFlags::Null | TypeFlags::Undefined)
    {
        return true;
    }
    if typ
        .flags()
        .intersects(TypeFlags::UnionOrIntersection | TypeFlags::TemplateLiteral)
    {
        return typ
            .types()
            .iter()
            .copied()
            .any(|member| type_includes_null_or_undefined(member, seen));
    }
    false
}

fn tuple_element_resolves_to_nullish(checker: &mut Checker, element: P<Node>) -> bool {
    let type_node = tuple_element_type_node(element);
    if !ast::is_type_node(type_node) {
        return false;
    }
    let resolved = checker.get_type_from_type_node_exported(type_node);
    let mut seen = FxHashSet::default();
    type_includes_null_or_undefined(resolved, &mut seen)
}

fn tuple_element_is_nullish_slot(checker: &mut Checker, element: P<Node>) -> bool {
    let type_node = tuple_element_type_node(element);
    tuple_element_is_optional(element)
        || type_node_includes_direct_nullish(type_node)
        || tuple_element_resolves_to_nullish(checker, element)
}

fn visit_nullable_positional_tuple(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if node.kind() != Kind::TupleType {
        return;
    }
    let elements = node.as_tuple_type_node().elements().nodes();
    let nullish_slots = elements
        .iter()
        .copied()
        .filter(|&element| tuple_element_is_nullish_slot(ctx.checker, element))
        .take(2)
        .count();
    if nullish_slots >= 2 {
        ctx.report_node(node, build_nullable_positional_tuple_message());
    }
}

struct ImportBinding {
    report_target: P<Node>,
    local_identifier: P<Node>,
}

fn build_service_constructor_import_message(
    module_specifier: &str,
    imported_name: &str,
) -> RuleMessage {
    RuleMessage::new(
        "serviceConstructorImport",
        format!(
            "Import the service tag or Layer from '{module_specifier}' instead of its raw constructor '{imported_name}'; resolve the service through the Effect context or wire '{imported_name}' inside a Layer."
        ),
    )
}

fn collect_import_bindings(import_clause: Option<P<Node>>) -> Vec<ImportBinding> {
    let Some(clause) = import_clause
        .filter(|c| c.kind() == Kind::ImportClause)
        .map(|c| c.as_import_clause())
        .filter(|c| c.phase_modifier() != Kind::TypeKeyword)
    else {
        return Vec::new();
    };
    let mut bindings = Vec::new();
    if let Some(name) = clause.name() {
        bindings.push(ImportBinding {
            report_target: name,
            local_identifier: name,
        });
    }
    if let Some(named) = clause
        .named_bindings()
        .filter(|n| n.kind() == Kind::NamedImports)
    {
        for &elem in named.as_named_imports().elements().nodes() {
            if elem.kind() == Kind::ImportSpecifier && !elem.as_import_specifier().is_type_only() {
                bindings.push(ImportBinding {
                    report_target: elem,
                    local_identifier: elem.as_import_specifier().name(),
                });
            }
        }
    }
    bindings
}

fn is_valid_service_target_file(ctx: &Ctx, target_file: P<SourceFile>) -> bool {
    target_file != ctx.file
        && !file_role::is_declaration_file(target_file.file_name())
        && !matches!(
            provenance::classify_source_file_origin(ctx.program, target_file, Some(ctx.file)),
            provenance::DeclarationOrigin::DefaultLib | provenance::DeclarationOrigin::NodeModules
        )
}

fn check_import_binding(
    ctx: &mut Ctx,
    import: P<Node>,
    module_text: &str,
    prov: &boundary::ServiceProvenance,
    binding: &ImportBinding,
) {
    let Some(raw_sym) = (binding.local_identifier.kind() == Kind::Identifier)
        .then(|| {
            ctx.checker
                .get_symbol_at_location_exported(binding.local_identifier)
        })
        .flatten()
    else {
        return;
    };
    let target_sym = provenance::resolve_aliased_symbol(ctx.checker, raw_sym);
    if prov.constructor_symbols.contains(&target_sym)
        && !boundary::is_only_used_in_layer_construction(
            ctx.checker,
            ctx.file,
            Some(import),
            binding.local_identifier,
        )
    {
        let imported_name = binding.local_identifier.as_identifier().text();
        ctx.report_node(
            binding.report_target,
            build_service_constructor_import_message(module_text, imported_name),
        );
    }
}

fn resolve_module_symbol(ctx: &mut Ctx, module_specifier: P<Node>) -> Option<P<Symbol>> {
    let raw = ctx
        .checker
        .get_symbol_at_location_exported(module_specifier)?;
    Some(provenance::resolve_aliased_symbol(ctx.checker, raw))
}

fn visit_service_constructor_imports(ctx: &mut Ctx, _listener: Listener, import: P<Node>) {
    if import.kind() != Kind::ImportDeclaration {
        return;
    }
    if file_role::ProjectPath::of(ctx.program, ctx.file.file_name())
        .has_any_role(file_role::TEST_ROLES)
    {
        return;
    }
    let import_decl = import.as_import_declaration();
    let module_specifier = import_decl.module_specifier();
    if module_specifier.kind() != Kind::StringLiteral {
        return;
    }
    let Some(module_text) = cooked_text(module_specifier) else {
        return;
    };
    let Some(target_file) = provenance::resolve_imported_source_file(ctx.checker, module_specifier)
    else {
        return;
    };
    if !is_valid_service_target_file(ctx, target_file) {
        return;
    }
    let module_symbol = resolve_module_symbol(ctx, module_specifier);
    let prov = boundary::service_contract_provenance(ctx.checker, module_symbol, target_file);
    if !prov.has_service_contract || prov.constructor_symbols.is_empty() {
        return;
    }
    for binding in collect_import_bindings(import_decl.import_clause()) {
        check_import_binding(ctx, import, module_text, &prov, &binding);
    }
}

pub(super) fn check_redundant_owner_prefix(ctx: &mut Ctx, node: P<Node>) {
    let Some(name_node) = node.name().filter(|n| ast::is_identifier(*n)) else {
        return;
    };
    let type_name = name_node.as_identifier().text();
    let words = split_identifier_words(type_name);
    if words.len() < 2 || words[0].len() < 3 {
        return;
    }
    let stem = &words[0];
    let members = match node.kind() {
        Kind::InterfaceDeclaration => node.as_interface_declaration().members().nodes(),
        Kind::TypeAliasDeclaration => {
            let Some(type_node) = node.as_type_alias_declaration().type_() else {
                return;
            };
            if type_node.kind() != Kind::TypeLiteral {
                return;
            }
            type_node.as_type_literal_node().members().nodes()
        }
        _ => return,
    };
    if members.len() < 3 {
        return;
    }
    let all_prefixed = members.iter().all(|&member| {
        if member.kind() != Kind::PropertySignature {
            return false;
        }
        let prop_name_node = member.as_property_signature_declaration().name();
        if !ast::is_identifier(prop_name_node) {
            return false;
        }
        prop_name_node
            .as_identifier()
            .text()
            .strip_prefix(stem.as_str())
            .and_then(|rest| rest.as_bytes().first())
            .is_some_and(u8::is_ascii_uppercase)
    });
    if all_prefixed {
        ctx.report_node(
            name_node,
            RuleMessage::new(
                "redundantOwnerPrefix",
                format!(
                    "Type '{type_name}' prefixes all {} fields with '{stem}'; drop the redundant owner prefix from field names.",
                    members.len()
                ),
            ),
        );
    }
}

fn is_protocol_type_name(name: &str) -> bool {
    ["Chunk", "Message", "Envelope", "StreamEvent", "Part"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

fn has_widened_finish_reason_member(members: &[P<Node>]) -> bool {
    members.iter().any(|&m| {
        if m.kind() != Kind::PropertySignature {
            return false;
        }
        let prop = m.as_property_signature_declaration();
        ast::is_identifier(prop.name())
            && matches!(
                prop.name().as_identifier().text(),
                "finishReason" | "stopReason"
            )
            && prop
                .type_()
                .is_some_and(|t| t.kind() == Kind::StringKeyword)
    })
}

fn type_node_has_widened_finish_reason(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::TypeLiteral => {
            has_widened_finish_reason_member(type_node.as_type_literal_node().members().nodes())
        }
        Kind::UnionType => type_node
            .as_union_type_node()
            .types()
            .nodes()
            .iter()
            .copied()
            .any(type_node_has_widened_finish_reason),
        _ => false,
    }
}

fn has_external_import(sf: P<SourceFile>) -> bool {
    sf.statements().nodes().iter().any(|&stmt| {
        stmt.kind() == Kind::ImportDeclaration && {
            let spec = stmt.as_import_declaration().module_specifier();
            spec.kind() == Kind::StringLiteral
                && cooked_text(spec).is_some_and(|s| !s.starts_with('.') && !s.starts_with("node:"))
        }
    })
}

fn count_sdk_part_literals(text: &str) -> usize {
    ["text", "tool-call", "tool-result", "reasoning", "image"]
        .iter()
        .filter(|&&k| text.contains(&format!("\"{k}\"")) || text.contains(&format!("'{k}'")))
        .count()
}

fn is_widened_or_redeclared_sdk_contract(sf: P<SourceFile>, node: P<Node>, name: &str) -> bool {
    match node.kind() {
        Kind::InterfaceDeclaration => {
            is_protocol_type_name(name)
                && has_widened_finish_reason_member(
                    node.as_interface_declaration().members().nodes(),
                )
        }
        Kind::TypeAliasDeclaration => {
            let Some(t) = node.as_type_alias_declaration().type_() else {
                return false;
            };
            is_protocol_type_name(name)
                && (type_node_has_widened_finish_reason(t)
                    || (t.kind() == Kind::UnionType
                        && has_external_import(sf)
                        && count_sdk_part_literals(antidrift_kernel::tsrs_kernel::node_text(
                            sf, t,
                        )) >= 3))
        }
        Kind::VariableDeclaration => {
            let Some(init) = node.as_variable_declaration().initializer() else {
                return false;
            };
            let text = antidrift_kernel::tsrs_kernel::node_text(sf, init);
            (name.contains("Part") || name.contains("Message") || name.contains("Chunk"))
                && has_external_import(sf)
                && (text.contains("union(") || text.contains("discriminatedUnion("))
                && count_sdk_part_literals(text) >= 3
        }
        _ => false,
    }
}

pub(super) fn check_sdk_transport_fork(ctx: &mut Ctx, node: P<Node>) {
    let Some(name_node) = node.name().filter(|n| ast::is_identifier(*n)) else {
        return;
    };
    let name = name_node.as_identifier().text();
    if is_widened_or_redeclared_sdk_contract(ctx.file, node, name) {
        ctx.report_node(
            name_node,
            RuleMessage::new(
                "sdkTransportContractFork",
                format!(
                    "Do not redeclare SDK transport contract '{name}' locally with widened fields (`finishReason: string`) or hand-built part unions; derive or import the contract from the SDK owner."
                ),
            ),
        );
    }
}
