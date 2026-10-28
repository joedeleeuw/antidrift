use super::owned_union_source::{
    ExportedArray, MemberSet, call_site, convex_bindings, exported_arrays, find_top_level_binding,
    is_shadowed_at, literal_type, validator_members,
};
use super::package_ownership::absolute_filename;
use super::package_resolution::resolver_with_mode;
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule_scope::decode_rule_options;
use antidrift_kernel::ts_resolver::ResolutionMode;
use oxc_resolver::{ResolveError, Resolver};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tsrs_ast::{
    self as ast, ExternalModuleIndicatorOptions, Kind, Node, SourceFile, SourceFileParseOptions,
};
use tsrs_compiler::CompilerHost;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-redeclared-owned-union";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusEntry {
    owner: String,
    values: Vec<String>,
    #[serde(default, rename = "valuesExport")]
    _values_export: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct OwnedUnionOptions {
    allows: BTreeSet<String>,
    statuses: BTreeMap<String, StatusEntry>,
}

struct UnionOwner {
    name: String,
    binding_name: String,
    symbol: Binding,
    members: MemberSet,
}

pub struct NoRedeclaredOwnedUnion {
    options: OwnedUnionOptions,
}

pub static DEFAULT_RULE: NoRedeclaredOwnedUnion = NoRedeclaredOwnedUnion {
    options: OwnedUnionOptions {
        allows: BTreeSet::new(),
        statuses: BTreeMap::new(),
    },
};

impl NoRedeclaredOwnedUnion {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            options: decode_rule_options::<OwnedUnionOptions>(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::LiteralType),
    Listener::Enter(Kind::TypeAliasDeclaration),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoRedeclaredOwnedUnion {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let host = ctx.program.host();
        let owners = match union_owners(ctx.file, host.as_ref()) {
            Ok(owners) => owners,
            Err(error) => {
                ctx.report_range(0, 0, RuleMessage::new("ownerResolution", error));
                return Box::new(Visitor {
                    rule: self,
                    enabled: false,
                    owners: Vec::new(),
                    convex: FxHashSet::default(),
                });
            }
        };
        let convex = convex_bindings(ctx.file);
        Box::new(Visitor {
            rule: self,
            enabled: true,
            owners,
            convex,
        })
    }
}

struct Visitor {
    rule: &'static NoRedeclaredOwnedUnion,
    enabled: bool,
    owners: Vec<UnionOwner>,
    convex: FxHashSet<Binding>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::LiteralType => {
                if let Some(message) =
                    status_report(node, &self.rule.options.statuses, ctx.file.file_name())
                {
                    ctx.report_node(node, RuleMessage::new("canonicalStatus", message));
                }
            }
            Kind::TypeAliasDeclaration => {
                let alias = node.as_type_alias_declaration();
                let Some(type_node) = alias.type_() else {
                    return;
                };
                if type_node.kind() != Kind::UnionType {
                    return;
                }
                let members = type_node
                    .as_union_type_node()
                    .types()
                    .nodes()
                    .iter()
                    .copied()
                    .map(literal_type)
                    .collect();
                let name_node = alias.name();
                let alias_name =
                    ast::is_identifier(name_node).then(|| name_node.as_identifier().text());
                if let Some((target, msg)) = owner_report(
                    node,
                    type_node,
                    members,
                    alias_name,
                    &self.owners,
                    &self.rule.options.allows,
                ) {
                    ctx.report_node(target, msg);
                }
            }
            Kind::CallExpression => {
                let members = validator_members(node, &self.convex);
                let name = call_site(node);
                if let Some((target, msg)) = owner_report(
                    node,
                    node,
                    members,
                    name.as_deref(),
                    &self.owners,
                    &self.rule.options.allows,
                ) {
                    ctx.report_node(target, msg);
                }
            }
            _ => {}
        }
    }
}

fn owner_report(
    scope_node: P<Node>,
    report_target: P<Node>,
    members: Option<MemberSet>,
    name: Option<&str>,
    owners: &[UnionOwner],
    allows: &BTreeSet<String>,
) -> Option<(P<Node>, RuleMessage)> {
    let members = members?;
    if members.is_empty() || name.is_some_and(|name| allows.contains(name)) {
        return None;
    }
    let owner = owners.iter().find(|owner| {
        owner.members == members && !is_shadowed_at(scope_node, &owner.binding_name, owner.symbol)
    })?;
    Some((
        report_target,
        RuleMessage::new(
            "redeclaredOwner",
            format!(
                "This union re-declares an owned literal value space; derive it from the owning runtime array {}.",
                owner.name
            ),
        ),
    ))
}

fn union_owners(sf: P<SourceFile>, host: &dyn CompilerHost) -> Result<Vec<UnionOwner>, String> {
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
                host,
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
                    name: local_text.to_string(),
                    binding_name: local_text.to_string(),
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
                binding_name: local_text.to_string(),
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
                name: local_text.to_string(),
                binding_name: local_text.to_string(),
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
    host: &dyn CompilerHost,
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
    if resolved.to_string_lossy().ends_with(".d.ts")
        || !resolved
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension,
                    "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts"
                )
            })
    {
        return Ok(&[]);
    }
    if !cache.contains_key(&resolved) {
        if let Err(error) = std::fs::metadata(&resolved) {
            return Err(format!(
                "{}: cannot read runtime array owner: {error}",
                resolved.display()
            ));
        }
        let file_name_str = tspath::normalize_slashes(&resolved.to_string_lossy());
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
    cache
        .get(&resolved)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{}: runtime array owner was not loaded", resolved.display()))
}

fn status_report(
    node: P<Node>,
    statuses: &BTreeMap<String, StatusEntry>,
    filename: &str,
) -> Option<String> {
    if node.kind() != Kind::LiteralType {
        return None;
    }
    let literal = node.as_literal_type_node().literal();
    if literal.kind() != Kind::StringLiteral {
        return None;
    }
    let text = literal.as_string_literal().text();
    let (_, entry) = statuses.iter().find(|(name, entry)| {
        entry.values.iter().any(|candidate| candidate == text) && status_context(node, name)
    })?;
    if filename
        .replace('\\', "/")
        .ends_with(&entry.owner.replace('\\', "/"))
    {
        return None;
    }
    Some(format!(
        "String literal '{text}' duplicates a canonical status from {}. Import the type instead.",
        entry.owner
    ))
}

fn normalized_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|letter| letter.to_ascii_lowercase())
        .collect()
}

fn status_context(node: P<Node>, name: &str) -> bool {
    let key = normalized_name(name);
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        let context = match ancestor.kind() {
            Kind::PropertySignature => return property_context(ancestor, &key),
            Kind::TypeAliasDeclaration
            | Kind::InterfaceDeclaration
            | Kind::VariableDeclaration
            | Kind::Parameter => ancestor
                .name()
                .filter(|id| ast::is_identifier(*id))
                .map(|id| id.as_identifier().text()),
            Kind::Identifier => Some(ancestor.as_identifier().text()),
            _ => None,
        };
        if let Some(context) = context {
            return !context.is_empty() && normalized_name(context) == key;
        }
        cursor = ancestor.parent();
    }
    false
}

fn property_context(property_sig: P<Node>, key: &str) -> bool {
    let property_name = property_sig
        .name()
        .map(|prop| match prop.kind() {
            Kind::Identifier => prop.as_identifier().text(),
            Kind::PrivateIdentifier => prop.as_private_identifier().text(),
            Kind::StringLiteral => prop.as_string_literal().text(),
            _ => "",
        })
        .unwrap_or("");
    if !property_name.is_empty() && normalized_name(property_name) == key {
        return true;
    }
    let mut owner = None;
    let mut cursor = property_sig.parent();
    while let Some(ancestor) = cursor {
        if matches!(
            ancestor.kind(),
            Kind::TypeAliasDeclaration | Kind::InterfaceDeclaration
        ) && let Some(name_node) = ancestor.name()
            && ast::is_identifier(name_node)
        {
            owner = Some(name_node.as_identifier().text());
            break;
        }
        cursor = ancestor.parent();
    }
    owner.is_some_and(|owner| normalized_name(&format!("{owner}{property_name}")) == key)
}
