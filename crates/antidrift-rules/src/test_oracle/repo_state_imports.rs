use super::no_repo_state_mirror_assertion::RepoStateSourceOption;
use antidrift_kernel::tsrs_kernel::cooked_text;
use rustc_hash::FxHashMap;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

pub(super) fn collect_tainted_imports(
    stmts: &[P<Node>],
    sources: &[RepoStateSourceOption],
) -> FxHashMap<String, String> {
    let mut tainted = FxHashMap::default();
    if sources.is_empty() {
        return tainted;
    }
    for &stmt in stmts {
        if stmt.kind() == Kind::ImportDeclaration {
            collect_from_import_decl(stmt, sources, &mut tainted);
        }
    }
    tainted
}

fn collect_from_import_decl(
    import_node: P<Node>,
    sources: &[RepoStateSourceOption],
    tainted: &mut FxHashMap<String, String>,
) {
    let import_decl = import_node.as_import_declaration();
    let spec_lit = import_decl.module_specifier();
    if !ast::is_string_literal(spec_lit) {
        return;
    }
    let Some(module_specifier) = cooked_text(spec_lit) else {
        return;
    };
    let Some(clause_node) = import_decl.import_clause() else {
        return;
    };
    let clause = clause_node.as_import_clause();
    if let Some(default_name) = clause.name()
        && ast::is_identifier(default_name)
    {
        let local = default_name.as_identifier().text();
        if let Some(matched) = source_for_import(sources, module_specifier, local) {
            tainted.insert(local.to_owned(), matched.to_owned());
        }
    }
    let Some(bindings) = clause.named_bindings() else {
        return;
    };
    match bindings.kind() {
        Kind::NamespaceImport => {
            if let Some(ns_name) = bindings.name()
                && ast::is_identifier(ns_name)
            {
                let local = ns_name.as_identifier().text();
                if let Some(matched) = source_for_import(sources, module_specifier, local) {
                    tainted.insert(local.to_owned(), matched.to_owned());
                }
            }
        }
        Kind::NamedImports => {
            for &spec in bindings.as_named_imports().elements().nodes() {
                if spec.kind() == Kind::ImportSpecifier {
                    record_named_specifier(spec, sources, module_specifier, tainted);
                }
            }
        }
        _ => {}
    }
}

fn record_named_specifier(
    spec: P<Node>,
    sources: &[RepoStateSourceOption],
    module_specifier: &str,
    tainted: &mut FxHashMap<String, String>,
) {
    let Some(local_node) = spec.name() else {
        return;
    };
    if !ast::is_identifier(local_node) {
        return;
    }
    let local_name = local_node.as_identifier().text();
    let imported_name = spec
        .as_import_specifier()
        .property_name()
        .and_then(|prop| ast::is_identifier(prop).then(|| prop.as_identifier().text()))
        .unwrap_or(local_name);
    if let Some(matched) = source_for_import(sources, module_specifier, imported_name) {
        tainted.insert(local_name.to_owned(), matched.to_owned());
    }
}

fn source_for_import<'a>(
    sources: &'a [RepoStateSourceOption],
    module_specifier: &str,
    imported_name: &'a str,
) -> Option<&'a str> {
    for source in sources {
        if !module_specifier.contains(&source.module) {
            continue;
        }
        let matches_name = source
            .names
            .as_ref()
            .is_none_or(|names| names.iter().any(|n| n == imported_name));
        if matches_name {
            return Some(imported_name);
        }
    }
    None
}
