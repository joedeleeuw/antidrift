use super::no_redeclared_owned_union::UnionOwner;
use super::owned_union_source::{ExportedArray, exported_arrays, find_top_level_binding};
use super::package_ownership::absolute_filename;
use super::package_resolution::resolver_with_mode;
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::ts_resolver::ResolutionMode;
use oxc_resolver::{ResolveError, Resolver};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tsrs_ast::{
    self as ast, ExternalModuleIndicatorOptions, Kind, Node, SourceFile, SourceFileParseOptions,
};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::tspath;

pub(super) fn union_owners(
    program: &Program,
    sf: P<SourceFile>,
) -> Result<Vec<UnionOwner>, String> {
    let filename = sf.file_name();
    let mut owners = Vec::new();
    for array in exported_arrays(sf) {
        if let Some(symbol) = find_top_level_binding(sf, &array.local) {
            owners.push(UnionOwner {
                name: array.local.clone(),
                binding_name: array.local,
                symbol,
                members: array.members,
            });
        }
    }
    let mut resolver = None;
    let mut cache = BTreeMap::new();
    for &statement in sf.statements().nodes() {
        if statement.kind() != Kind::ImportDeclaration {
            continue;
        }
        let import = statement.as_import_declaration();
        let Some(clause_node) = import.import_clause() else {
            continue;
        };
        let clause = clause_node.as_import_clause();
        if clause.phase_modifier() == Kind::TypeKeyword {
            continue;
        }
        let spec = import.module_specifier();
        if !ast::is_string_literal(spec) {
            continue;
        }
        if resolver.is_none() {
            resolver = Some(resolver_with_mode(
                Path::new(filename),
                ResolutionMode::Import,
            )?);
        }
        if let Some(resolver) = &resolver {
            let arrays = imported_arrays(
                filename,
                spec.as_string_literal().text(),
                resolver,
                program,
                &mut cache,
            )?;
            add_import_owners(clause_node, arrays, &mut owners);
        }
    }
    Ok(owners)
}

fn add_import_owners(clause_node: P<Node>, arrays: &[ExportedArray], owners: &mut Vec<UnionOwner>) {
    let clause = clause_node.as_import_clause();
    if let Some(default_name) = clause.name()
        && ast::is_identifier(default_name)
    {
        let local_text = default_name.as_identifier().text();
        let symbol = Binding {
            decl: clause_node,
            ident: default_name,
        };
        for array in arrays {
            if array.name == "default" {
                owners.push(UnionOwner {
                    name: local_text.to_owned(),
                    binding_name: local_text.to_owned(),
                    symbol,
                    members: array.members.clone(),
                });
            }
        }
    }
    let Some(bindings) = clause.named_bindings() else {
        return;
    };
    match bindings.kind() {
        Kind::NamespaceImport => add_namespace_import_owners(bindings, arrays, owners),
        Kind::NamedImports => {
            for &elem in bindings.as_named_imports().elements().nodes() {
                add_named_import_specifier_owners(elem, arrays, owners);
            }
        }
        _ => {}
    }
}

fn add_namespace_import_owners(
    bindings: P<Node>,
    arrays: &[ExportedArray],
    owners: &mut Vec<UnionOwner>,
) {
    let ns_name = bindings.as_namespace_import().name();
    if !ast::is_identifier(ns_name) {
        return;
    }
    let local_text = ns_name.as_identifier().text();
    let symbol = Binding {
        decl: bindings,
        ident: ns_name,
    };
    for array in arrays {
        if array.name != "default" {
            owners.push(UnionOwner {
                name: format!("{local_text}.{}", array.name),
                binding_name: local_text.to_owned(),
                symbol,
                members: array.members.clone(),
            });
        }
    }
}

fn add_named_import_specifier_owners(
    elem: P<Node>,
    arrays: &[ExportedArray],
    owners: &mut Vec<UnionOwner>,
) {
    if elem.kind() != Kind::ImportSpecifier {
        return;
    }
    let spec = elem.as_import_specifier();
    if spec.is_type_only() {
        return;
    }
    let local_node = spec.name();
    if !ast::is_identifier(local_node) {
        return;
    }
    let local_text = local_node.as_identifier().text();
    let imported_text = spec
        .property_name()
        .and_then(|prop| match prop.kind() {
            Kind::Identifier => Some(prop.as_identifier().text()),
            Kind::StringLiteral => Some(prop.as_string_literal().text()),
            _ => None,
        })
        .unwrap_or(local_text);
    let symbol = Binding {
        decl: elem,
        ident: local_node,
    };
    for array in arrays {
        if array.name == imported_text {
            owners.push(UnionOwner {
                name: local_text.to_owned(),
                binding_name: local_text.to_owned(),
                symbol,
                members: array.members.clone(),
            });
        }
    }
}

fn imported_arrays<'c>(
    filename: &str,
    specifier: &str,
    resolver: &Resolver,
    program: &Program,
    cache: &'c mut BTreeMap<PathBuf, Vec<ExportedArray>>,
) -> Result<&'c [ExportedArray], String> {
    let abs_filename = absolute_filename(Path::new(filename))?;
    let directory = abs_filename.parent().unwrap_or(Path::new("."));
    let resolved = match resolver.resolve(directory, specifier) {
        Ok(resolved) => resolved.full_path(),
        Err(
            ResolveError::NotFound(_)
            | ResolveError::Builtin { .. }
            | ResolveError::MatchedAliasNotFound(_, _)
            | ResolveError::ExtensionAlias(_, _, _)
            | ResolveError::PackagePathNotExported { .. }
            | ResolveError::PackageImportNotDefined(_, _),
        ) => return Ok(&[]),
        Err(error) => {
            return Err(format!(
                "{filename}: cannot resolve owner import '{specifier}': {error}"
            ));
        }
    };
    let file_name_str = tspath::normalize_slashes(&resolved.to_string_lossy());
    if tspath::is_declaration_file_name(&file_name_str)
        || !(tspath::has_implementation_ts_file_extension(&file_name_str)
            || tspath::has_js_file_extension(&file_name_str))
    {
        return Ok(&[]);
    }
    if !cache.contains_key(&resolved) {
        if let Some(&loaded_sf) = program
            .get_source_files()
            .iter()
            .find(|sf| tspath::normalize_slashes(sf.file_name()) == file_name_str)
        {
            cache.insert(resolved.clone(), exported_arrays(loaded_sf));
        } else {
            if let Err(error) = std::fs::metadata(&resolved) {
                return Err(format!(
                    "{}: cannot read runtime array owner: {error}",
                    resolved.display()
                ));
            }
            let host = program.host();
            let path_obj = tspath::to_path(&file_name_str, host.get_current_directory(), true);
            let opts = SourceFileParseOptions {
                file_name: file_name_str,
                path: path_obj,
                external_module_indicator_options: ExternalModuleIndicatorOptions::default(),
            };
            let Some(parsed_sf) = host.get_source_file(opts) else {
                return Err(format!(
                    "{}: cannot parse runtime array owner",
                    resolved.display()
                ));
            };
            cache.insert(resolved.clone(), exported_arrays(parsed_sf));
        }
    }
    cache
        .get(&resolved)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{}: runtime array owner was not loaded", resolved.display()))
}
