use antidrift_kernel::provenance::relative_to_cwd;
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use antidrift_kernel::tsrs_kernel::{
    assertion_parts, cooked_text_lossy, is_const_assertion, unwrap_parentheses,
};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const AS_LISTENERS: &[Listener] = &[Listener::Enter(Kind::AsExpression)];
const EOF_LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];
const SATISFIES_LISTENERS: &[Listener] = &[Listener::Enter(Kind::SatisfiesExpression)];
const CAST_CHAIN_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::AsExpression),
    Listener::Enter(Kind::TypeAssertionExpression),
];
const HOST_PATH_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::StringLiteral),
    Listener::Enter(Kind::NoSubstitutionTemplateLiteral),
];

const PARTIAL_RECORD_MESSAGE: &str = "Don't pin an object literal with `satisfies Partial<Record<...>>` — Partial cancels the totality check satisfies would otherwise give you, so a union member can silently fall through. Make the record total (explicit 'none'/false/null per member), narrow the key union, or add an eslint-disable naming what absence means for genuinely sparse data.";
const CAST_CHAIN_MESSAGE: &str = "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";

pub static NO_AS_NEVER: RuleSpec =
    RuleSpec::new("antidrift/no-as-never", AS_LISTENERS, visit_as_never);
pub static NO_DEBUG_RESIDUE_FILENAMES: RuleSpec = RuleSpec::new(
    "antidrift/no-debug-residue-filenames",
    EOF_LISTENERS,
    visit_debug_residue_filenames,
);
pub static NO_HOST_PATH_LITERAL: RuleSpec = RuleSpec::new(
    "antidrift/no-host-path-literal",
    HOST_PATH_LISTENERS,
    visit_host_path_literal,
);
pub static NO_PARTIAL_RECORD_SATISFIES: RuleSpec = RuleSpec::new(
    "antidrift/no-partial-record-satisfies",
    SATISFIES_LISTENERS,
    visit_partial_record_satisfies,
);
pub static NO_UNKNOWN_TYPE_ALIASES: RuleSpec = RuleSpec::new(
    "antidrift/no-unknown-type-aliases",
    EOF_LISTENERS,
    visit_unknown_type_aliases,
);
pub static NO_UNSAFE_CAST_CHAIN: RuleSpec = RuleSpec::new(
    "antidrift/no-unsafe-cast-chain",
    CAST_CHAIN_LISTENERS,
    visit_unsafe_cast_chain,
);

fn visit_as_never(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if node.kind() != Kind::AsExpression {
        return;
    }
    let type_node = node.as_as_expression().type_();
    if is_never_type_annotation(type_node) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "forbidden",
                "Do not cast to 'never'. Fix the type boundary instead.",
            ),
        );
    }
}

fn is_never_type_annotation(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::NeverKeyword => true,
        Kind::TypeReference => {
            let name = type_node.as_type_reference_node().type_name();
            ast::is_identifier(name) && name.as_identifier().text() == "never"
        }
        _ => false,
    }
}

fn visit_debug_residue_filenames(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
    let file_name = ctx.file.file_name();
    if !has_debug_residue_filename(file_name) {
        return;
    }
    let display = relative_to_cwd(ctx.program.host().get_current_directory(), file_name);
    let end = i32::try_from(ctx.file.text().len()).unwrap_or(0);
    ctx.report_range(
        0,
        end,
        RuleMessage::new(
            "debugResidue",
            format!(
                "Filename '{display}' looks like debug residue. Rename the file to its real intent."
            ),
        ),
    );
}

fn has_debug_residue_filename(file_path: &str) -> bool {
    let normalized = file_path.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    if base.is_empty() {
        return false;
    }
    let lower = base.to_ascii_lowercase();
    let without_final_ext = match lower.rfind('.') {
        Some(idx) if idx > 0 => &lower[..idx],
        _ => lower.as_str(),
    };
    for candidate in [lower.as_str(), without_final_ext] {
        if candidate.ends_with("_old")
            || candidate.ends_with("_backup")
            || candidate.ends_with("_temp")
            || candidate.ends_with("_v2")
            || candidate.ends_with(".bak")
            || candidate.ends_with(".old")
            || candidate.ends_with(".backup")
        {
            return true;
        }
    }
    false
}

fn visit_host_path_literal(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if !matches!(
        node.kind(),
        Kind::StringLiteral | Kind::NoSubstitutionTemplateLiteral
    ) {
        return;
    }
    let text = cooked_text_lossy(node);
    if is_host_path_literal(&text) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "hostPathLiteral",
                "Host-absolute path literal. Resolve the path from the home directory, the repository root, or configuration.",
            ),
        );
    }
}

fn is_host_path_literal(text: &str) -> bool {
    let rest = text
        .strip_prefix("/Users/")
        .or_else(|| text.strip_prefix("/home/"));
    let Some(after_root) = rest else {
        return false;
    };
    let Some((user_segment, _)) = after_root.split_once('/') else {
        return false;
    };
    !user_segment.is_empty() && user_segment != "linuxbrew"
}

fn visit_partial_record_satisfies(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if node.kind() != Kind::SatisfiesExpression {
        return;
    }
    let sat = node.as_satisfies_expression();
    if is_partial_record_type(sat.type_()) && is_object_literal_expr(sat.expression()) {
        ctx.report_node(
            node,
            RuleMessage::new("noPartialRecordSatisfies", PARTIAL_RECORD_MESSAGE),
        );
    }
}

fn unwrap_readonly_type(type_node: P<Node>) -> P<Node> {
    if type_node.kind() == Kind::TypeReference {
        let type_ref = type_node.as_type_reference_node();
        if is_type_name_ident(type_ref.type_name(), "Readonly")
            && let Some(&first) = type_node.type_arguments().first()
        {
            return first;
        }
    }
    type_node
}

fn is_partial_record_type(type_node: P<Node>) -> bool {
    let outer = unwrap_readonly_type(type_node);
    if outer.kind() != Kind::TypeReference {
        return false;
    }
    let outer_ref = outer.as_type_reference_node();
    if !is_type_name_ident(outer_ref.type_name(), "Partial") {
        return false;
    }
    let Some(&first_arg) = outer.type_arguments().first() else {
        return false;
    };
    let inner = unwrap_readonly_type(first_arg);
    if inner.kind() != Kind::TypeReference {
        return false;
    }
    is_type_name_ident(inner.as_type_reference_node().type_name(), "Record")
}

fn is_type_name_ident(name_node: P<Node>, expected: &str) -> bool {
    ast::is_identifier(name_node) && name_node.as_identifier().text() == expected
}

fn is_object_literal_expr(expr: P<Node>) -> bool {
    let unwrapped = unwrap_parentheses(expr);
    match unwrapped.kind() {
        Kind::ObjectLiteralExpression => true,
        Kind::AsExpression => {
            let as_expr = unwrapped.as_as_expression();
            is_const_assertion(as_expr.type_()) && is_object_literal_expr(as_expr.expression())
        }
        _ => false,
    }
}

fn visit_unknown_type_aliases(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
    let mut aliases: FxHashMap<&'static str, P<Node>> = FxHashMap::default();
    let mut ordered_names = Vec::new();
    for &stmt in ctx.file.statements().nodes() {
        if stmt.kind() != Kind::TypeAliasDeclaration {
            continue;
        }
        let Some(name_node) = stmt.name() else {
            continue;
        };
        if !ast::is_identifier(name_node) {
            continue;
        }
        let name = name_node.as_identifier().text();
        if !aliases.contains_key(name) {
            ordered_names.push(name);
        }
        aliases.insert(name, stmt);
    }
    for name in ordered_names {
        let Some(&decl) = aliases.get(name) else {
            continue;
        };
        let mut visited = FxHashSet::default();
        visited.insert(name);
        let Some(type_node) = decl.as_type_alias_declaration().type_() else {
            continue;
        };
        if resolves_to_unknown(type_node, &aliases, &mut visited) {
            let target = decl.name().unwrap_or(decl);
            ctx.report_node(
                target,
                RuleMessage::new(
                    "unknownAlias",
                    format!(
                        "Type alias `{name}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type."
                    ),
                ),
            );
        }
    }
}

fn resolves_to_unknown(
    type_node: P<Node>,
    aliases: &FxHashMap<&'static str, P<Node>>,
    visited: &mut FxHashSet<&'static str>,
) -> bool {
    match type_node.kind() {
        Kind::UnknownKeyword => true,
        Kind::ParenthesizedType => resolves_to_unknown(
            type_node.as_parenthesized_type_node().type_(),
            aliases,
            visited,
        ),
        _ => {
            let Some(target_name) = referenced_alias_name(type_node) else {
                return false;
            };
            if !visited.insert(target_name) {
                return false;
            }
            let Some(&alias_decl) = aliases.get(target_name) else {
                return false;
            };
            if !alias_decl.type_parameters().is_empty() {
                return false;
            }
            let Some(alias_type) = alias_decl.as_type_alias_declaration().type_() else {
                return false;
            };
            resolves_to_unknown(alias_type, aliases, visited)
        }
    }
}

fn referenced_alias_name(type_node: P<Node>) -> Option<&'static str> {
    match type_node.kind() {
        Kind::ParenthesizedType => {
            referenced_alias_name(type_node.as_parenthesized_type_node().type_())
        }
        Kind::TypeReference => {
            if !type_node.type_arguments().is_empty() {
                return None;
            }
            let name = type_node.as_type_reference_node().type_name();
            ast::is_identifier(name).then(|| name.as_identifier().text())
        }
        _ => None,
    }
}

fn visit_unsafe_cast_chain(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let Some((inner, ty)) = assertion_parts(node) else {
        return;
    };
    if !is_outermost_assertion_in_chain(node) {
        return;
    }
    if is_forbidden_assertion_chain(inner, ty) {
        ctx.report_node(node, RuleMessage::new("chained", CAST_CHAIN_MESSAGE));
    }
}

fn is_outermost_assertion_in_chain(node: P<Node>) -> bool {
    let mut cursor = node.parent();
    while let Some(parent) = cursor {
        match parent.kind() {
            Kind::ParenthesizedExpression => {
                cursor = parent.parent();
            }
            Kind::AsExpression | Kind::TypeAssertionExpression => return false,
            _ => return true,
        }
    }
    true
}

fn is_forbidden_assertion_chain(first_inner: P<Node>, first_ty: P<Node>) -> bool {
    let mut assertion_count = 1usize;
    let mut has_non_const = !is_const_assertion(first_ty);
    let mut current = unwrap_parentheses(first_inner);
    while let Some((next_inner, next_ty)) = assertion_parts(current) {
        assertion_count += 1;
        if !is_const_assertion(next_ty) {
            has_non_const = true;
        }
        current = unwrap_parentheses(next_inner);
    }
    assertion_count > 1 && has_non_const
}
