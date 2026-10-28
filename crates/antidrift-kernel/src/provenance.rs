use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, SourceFile, Symbol, SymbolFlags, TypeReferenceNode};
use tsrs_checker::{Checker, Type};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrslint::utils::is_source_file_default_library;

use crate::tsrs_kernel;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeclarationOrigin {
    Unknown,
    DefaultLib,
    NodeModules,
    Generated,
    SameFile,
    LocalDomain,
    LocalBoundary,
    WorkspaceOther,
}

const BUILTIN_OWNER_NAMES: &[&str] = &[
    "Array",
    "ReadonlyArray",
    "Promise",
    "PromiseLike",
    "Record",
    "Partial",
    "Required",
    "Readonly",
    "Pick",
    "Omit",
    "Exclude",
    "Extract",
    "NonNullable",
    "ReturnType",
    "Parameters",
    "ConstructorParameters",
    "InstanceType",
    "Awaited",
    "Map",
    "ReadonlyMap",
    "Set",
    "ReadonlySet",
    "WeakMap",
    "WeakSet",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "URL",
    "URLSearchParams",
    "AbortSignal",
    "AbortController",
    "Request",
    "Response",
    "Headers",
    "FormData",
    "Blob",
    "File",
    "Uint8Array",
    "ArrayBuffer",
    "Object",
    "Function",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "BigInt",
];

#[must_use]
pub fn is_builtin_owner_name(name: &str) -> bool {
    BUILTIN_OWNER_NAMES.contains(&name)
}

pub fn resolve_aliased_symbol(checker: &mut Checker, sym: P<Symbol>) -> P<Symbol> {
    if sym.flags.get().intersects(SymbolFlags::Alias) {
        let resolved = checker.get_aliased_symbol(sym);
        if resolved != sym {
            return resolved;
        }
    }
    sym
}

pub fn symbol_at_node(checker: &mut Checker, node: P<Node>) -> Option<P<Symbol>> {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    let mut sym = match checker.get_symbol_at_location_exported(unwrapped) {
        Some(found)
            if !checker.is_unknown_symbol(found)
                && (!found.declarations().is_empty() || found.value_declaration().is_some()) =>
        {
            found
        }
        _ if ast::is_identifier(unwrapped) => {
            let text = unwrapped.as_identifier().text();
            checker
                .get_symbols_in_scope_exported(
                    unwrapped,
                    SymbolFlags::Value
                        | SymbolFlags::Type
                        | SymbolFlags::Namespace
                        | SymbolFlags::Alias,
                )
                .into_iter()
                .find(|candidate| candidate.name() == text)?
        }
        Some(found) => found,
        None => return None,
    };
    if let Some(val_decl) = sym.value_declaration()
        && ast::is_shorthand_property_assignment(val_decl)
        && let Some(shorthand) = checker.get_shorthand_assignment_value_symbol(Some(val_decl))
    {
        sym = shorthand;
    }
    Some(resolve_aliased_symbol(checker, sym))
}

pub fn symbol_declarations(checker: &mut Checker, sym: Option<P<Symbol>>) -> Vec<P<Node>> {
    let Some(symbol) = sym else {
        return Vec::new();
    };
    let resolved = resolve_aliased_symbol(checker, symbol);
    let decls = resolved.declarations();
    if !decls.is_empty() {
        return decls.to_vec();
    }
    resolved.value_declaration().into_iter().collect()
}

#[must_use]
pub fn type_symbol(typ: P<Type>) -> Option<P<Symbol>> {
    if let Some(alias) = typ.alias()
        && let Some(sym) = alias.symbol()
    {
        return Some(sym);
    }
    typ.symbol()
}

#[must_use]
pub fn classify_source_file_origin(
    program: &Program,
    decl_file: P<SourceFile>,
    current_file: Option<P<SourceFile>>,
) -> DeclarationOrigin {
    let file_name = tsrs_kernel::normalize_path(decl_file.file_name());
    if is_source_file_default_library(program, decl_file) {
        return DeclarationOrigin::DefaultLib;
    }
    let wrapped = format!("/{file_name}/");
    if wrapped.contains("/node_modules/") || program.is_source_file_from_external_library(decl_file)
    {
        return DeclarationOrigin::NodeModules;
    }
    if tsrs_kernel::is_generated_file(&file_name, decl_file.text()) {
        return DeclarationOrigin::Generated;
    }
    if let Some(curr) = current_file
        && tsrs_kernel::normalize_path(curr.file_name()) == file_name
    {
        return DeclarationOrigin::SameFile;
    }
    if tsrs_kernel::is_domain_file(&file_name) {
        return DeclarationOrigin::LocalDomain;
    }
    if tsrs_kernel::is_boundary_file(&file_name) {
        return DeclarationOrigin::LocalBoundary;
    }
    DeclarationOrigin::WorkspaceOther
}

pub fn classify_symbol_origin(
    program: &Program,
    checker: &mut Checker,
    sym: Option<P<Symbol>>,
    current_file: Option<P<SourceFile>>,
) -> DeclarationOrigin {
    let decls = symbol_declarations(checker, sym);
    for decl in decls {
        if let Some(sf) = ast::get_source_file_of_node(decl) {
            let origin = classify_source_file_origin(program, sf, current_file);
            if origin != DeclarationOrigin::Unknown {
                return origin;
            }
        }
    }
    DeclarationOrigin::Unknown
}

pub fn classify_type_origin(
    program: &Program,
    checker: &mut Checker,
    typ: P<Type>,
    current_file: Option<P<SourceFile>>,
) -> DeclarationOrigin {
    let sym = type_symbol(typ);
    classify_symbol_origin(program, checker, sym, current_file)
}

#[must_use]
pub fn type_name_text(type_name: P<Node>) -> String {
    if ast::is_identifier(type_name) {
        return type_name.as_identifier().text().to_string();
    }
    if ast::is_qualified_name(type_name) {
        let qn = type_name.as_qualified_name();
        let left = type_name_text(qn.left());
        if !left.is_empty() {
            return left;
        }
        if ast::is_identifier(qn.right()) {
            return qn.right().as_identifier().text().to_string();
        }
    }
    String::new()
}

pub fn collect_type_owner_names(type_node: Option<P<Node>>, names: &mut FxHashSet<String>) {
    let Some(node) = type_node else {
        return;
    };
    match node.kind() {
        Kind::TypeReference => {
            let type_ref = node.as_type_reference_node();
            let name = type_name_text(type_ref.type_name());
            if !name.is_empty() && !is_builtin_owner_name(&name) {
                names.insert(name);
            }
            if let Some(args) = type_ref.type_arguments() {
                for &arg in args.nodes() {
                    collect_type_owner_names(Some(arg), names);
                }
            }
        }
        Kind::IndexedAccessType => {
            collect_type_owner_names(
                Some(node.as_indexed_access_type_node().object_type()),
                names,
            );
        }
        Kind::UnionType | Kind::IntersectionType => {
            for &part in tsrs_kernel::union_or_intersection_type_nodes(node) {
                collect_type_owner_names(Some(part), names);
            }
        }
        Kind::ArrayType => {
            collect_type_owner_names(Some(node.as_array_type_node().element_type()), names);
        }
        Kind::TypeOperator => {
            collect_type_owner_names(Some(node.as_type_operator_node().type_()), names);
        }
        Kind::ParenthesizedType => {
            collect_type_owner_names(Some(node.as_parenthesized_type_node().type_()), names);
        }
        _ => {}
    }
}

fn is_nullish_or_void_type_node(part: P<Node>) -> bool {
    if matches!(
        part.kind(),
        Kind::NullKeyword | Kind::UndefinedKeyword | Kind::VoidKeyword
    ) {
        return true;
    }
    part.kind() == Kind::LiteralType
        && part.as_literal_type_node().literal().kind() == Kind::NullKeyword
}

fn is_owned_composite_type_node(
    program: &Program,
    checker: &mut Checker,
    type_node: P<Node>,
    current_file: Option<P<SourceFile>>,
) -> bool {
    let mut has_owned = false;
    for &part in tsrs_kernel::union_or_intersection_type_nodes(type_node) {
        if is_nullish_or_void_type_node(part) {
            continue;
        }
        if !is_owned_contract_type_node(program, checker, Some(part), current_file) {
            return false;
        }
        has_owned = true;
    }
    has_owned
}

fn is_owned_type_reference_node(
    program: &Program,
    checker: &mut Checker,
    type_ref: &TypeReferenceNode,
    current_file: Option<P<SourceFile>>,
) -> bool {
    let name = type_name_text(type_ref.type_name());
    if is_builtin_owner_name(&name) {
        if matches!(
            name.as_str(),
            "Promise" | "PromiseLike" | "Readonly" | "NonNullable"
        ) && let Some(args) = type_ref.type_arguments()
            && args.nodes().len() == 1
        {
            return is_owned_contract_type_node(
                program,
                checker,
                Some(args.nodes()[0]),
                current_file,
            );
        }
        return false;
    }
    let sym = symbol_at_node(checker, type_ref.type_name());
    let decls = symbol_declarations(checker, sym);
    if decls.is_empty() {
        return true;
    }
    for decl in decls {
        if let Some(sf) = ast::get_source_file_of_node(decl)
            && is_source_file_default_library(program, sf)
        {
            continue;
        }
        if matches!(
            decl.kind(),
            Kind::InterfaceDeclaration
                | Kind::TypeAliasDeclaration
                | Kind::ClassDeclaration
                | Kind::EnumDeclaration
        ) {
            return true;
        }
    }
    false
}

pub fn is_owned_contract_type_node(
    program: &Program,
    checker: &mut Checker,
    type_node: Option<P<Node>>,
    current_file: Option<P<SourceFile>>,
) -> bool {
    let Some(node) = type_node else {
        return false;
    };
    match node.kind() {
        Kind::ParenthesizedType => is_owned_contract_type_node(
            program,
            checker,
            Some(node.as_parenthesized_type_node().type_()),
            current_file,
        ),
        Kind::UnionType | Kind::IntersectionType => {
            is_owned_composite_type_node(program, checker, node, current_file)
        }
        Kind::TypeReference => is_owned_type_reference_node(
            program,
            checker,
            node.as_type_reference_node(),
            current_file,
        ),
        _ => false,
    }
}

pub fn resolve_imported_source_file(
    checker: &mut Checker,
    module_specifier: P<Node>,
) -> Option<P<SourceFile>> {
    if !ast::is_string_literal_like(module_specifier) {
        return None;
    }
    let sym = checker.get_symbol_at_location_exported(module_specifier)?;
    if let Some(val_decl) = sym.value_declaration()
        && ast::is_source_file(val_decl)
    {
        return Some(val_decl.as_source_file_p());
    }
    for &decl in sym.declarations() {
        if ast::is_source_file(decl) {
            return Some(decl.as_source_file_p());
        }
    }
    None
}

#[must_use]
pub fn relative_to_cwd(cwd: &str, file_path: &str) -> String {
    let norm_cwd = format!("{}/", tspath::normalize_slashes(cwd).trim_end_matches('/'));
    let norm_file = tspath::normalize_slashes(file_path);
    norm_file
        .strip_prefix(&norm_cwd)
        .unwrap_or(&norm_file)
        .to_string()
}

fn collect_json_strings(val: &serde_json::Value, out: &mut Vec<String>) {
    match val {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_json_strings(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_json_strings(item, out);
            }
        }
        _ => {}
    }
}

fn manifest_entries(pkg_path: &std::path::Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(pkg_path).ok()?;
    let val = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let obj = val.as_object()?;
    let mut entries = Vec::new();
    for key in [
        "exports", "main", "module", "types", "typings", "browser", "bin", "source",
    ] {
        if let Some(field) = obj.get(key) {
            collect_json_strings(field, &mut entries);
        }
    }
    Some(entries)
}

#[must_use]
pub fn is_package_entry_file(file_name: &str) -> bool {
    let norm_file = tspath::normalize_slashes(file_name);
    let mut dir = std::path::Path::new(&norm_file).parent();
    while let Some(cur) = dir {
        let pkg_path = cur.join("package.json");
        if pkg_path.is_file() {
            let Some(entries) = manifest_entries(&pkg_path) else {
                return false;
            };
            let pkg_dir = tspath::normalize_slashes(&cur.to_string_lossy());
            return entries.iter().any(|entry| {
                let rel = entry.trim_start_matches("./").trim_start_matches('/');
                format!("{pkg_dir}/{rel}") == norm_file
            });
        }
        dir = cur.parent();
    }
    false
}
