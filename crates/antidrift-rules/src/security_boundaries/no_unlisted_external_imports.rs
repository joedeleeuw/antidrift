use super::package_ownership::{PackageFormat, PackageOwner, absolute_filename, package_owner};
use super::package_resolution::{
    resolution_config, resolve_dependency, resolver_with_mode, unresolved_module,
};
use antidrift_kernel::imports::{ModuleImport, extract_module_import};
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options, in_scope};
use antidrift_kernel::ts_resolver::ResolutionMode;
use oxc_resolver::{ResolveError, Resolver};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unlisted-external-imports";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct DependencyOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    internal_prefixes: Vec<String>,
    ancestor_dev_dependencies: bool,
}

impl Default for DependencyOptions {
    fn default() -> Self {
        Self {
            scope: ScopeOptions::default(),
            internal_prefixes: vec!["@/".to_owned(), "~/".to_owned()],
            ancestor_dev_dependencies: true,
        }
    }
}

pub struct NoUnlistedExternalImports {
    scope: RuleScope,
    internal_prefixes: Vec<&'static str>,
    ancestor_dev_dependencies: bool,
}

pub static DEFAULT_RULE: NoUnlistedExternalImports = NoUnlistedExternalImports {
    scope: RuleScope::DEFAULT,
    internal_prefixes: Vec::new(),
    ancestor_dev_dependencies: true,
};

impl NoUnlistedExternalImports {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<DependencyOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        let internal_prefixes = parsed
            .internal_prefixes
            .into_iter()
            .map(|prefix| -> &'static str { Box::leak(prefix.into_boxed_str()) })
            .collect();
        Ok(Self {
            scope,
            internal_prefixes,
            ancestor_dev_dependencies: parsed.ancestor_dev_dependencies,
        })
    }

    fn prefixes(&self) -> &[&str] {
        if self.internal_prefixes.is_empty() {
            &["@/", "~/"]
        } else {
            &self.internal_prefixes
        }
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ImportDeclaration),
    Listener::Enter(Kind::ExportDeclaration),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoUnlistedExternalImports {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        if !enabled {
            return Box::new(Visitor {
                rule: self,
                contract: None,
            });
        }
        match DependencyContract::load(ctx.file.file_name(), self.ancestor_dev_dependencies) {
            Ok(contract) => Box::new(Visitor {
                rule: self,
                contract: Some(contract),
            }),
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidDependencyContract", message));
                Box::new(Visitor {
                    rule: self,
                    contract: None,
                })
            }
        }
    }
}

struct Visitor {
    rule: &'static NoUnlistedExternalImports,
    contract: Option<DependencyContract>,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.contract.is_some() {
            LISTENERS
        } else {
            &[]
        }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        let Some(contract) = &self.contract else {
            return;
        };
        let Some(import) = extract_module_import(node) else {
            return;
        };
        if self
            .rule
            .prefixes()
            .iter()
            .any(|prefix| import.source.starts_with(prefix))
        {
            return;
        }
        match contract.unlisted(&import) {
            Ok(Some(name)) => {
                let (message_id, message) = if import.type_only {
                    (
                        "unlistedTypes",
                        format!(
                            "Declare '{name}' or its type provider in the importing package's package.json; that package owns its type dependency contract."
                        ),
                    )
                } else {
                    (
                        "unlisted",
                        format!(
                            "Declare '{name}' in the importing package's package.json; that package owns its dependency contract."
                        ),
                    )
                };
                ctx.report_node(import.node, RuleMessage::new(message_id, message));
            }
            Ok(None) => {}
            Err(message) => {
                ctx.report_range(0, 0, RuleMessage::new("invalidDependencyContract", message));
            }
        }
    }
}

struct DependencyContract {
    filename: PathBuf,
    owner: Option<PackageOwner>,
    dependencies: BTreeSet<String>,
    type_dependencies: BTreeSet<String>,
    aliases: Vec<String>,
    import_resolver: Resolver,
    require_resolver: Resolver,
    mode: ResolutionMode,
}

impl DependencyContract {
    fn load(filename: &str, ancestor_dev_dependencies: bool) -> Result<Self, String> {
        let filename = absolute_filename(Path::new(filename))?;
        let owner = package_owner(&filename)?;
        let mut dependencies = BTreeSet::new();
        if let Some(owner) = &owner {
            dependencies.extend(owner.manifest.name.iter().cloned());
            for group in [
                &owner.manifest.dependencies,
                &owner.manifest.dev_dependencies,
                &owner.manifest.peer_dependencies,
                &owner.manifest.optional_dependencies,
            ]
            .into_iter()
            .flatten()
            {
                dependencies.extend(group.keys().cloned());
            }
            if ancestor_dev_dependencies {
                collect_ancestor_dependencies(owner, &mut dependencies)?;
            }
        }
        let mut type_dependencies = dependencies.clone();
        type_dependencies.extend(dependencies.iter().map(|name| imported_name(name)));
        let import_resolver = resolver_with_mode(&filename, ResolutionMode::Import)?;
        let require_resolver = resolver_with_mode(&filename, ResolutionMode::Require)?;
        let config = resolution_config(&filename, &import_resolver)?;
        let mode = file_resolution_mode(&filename, owner.as_ref(), config.default_mode);
        Ok(Self {
            filename,
            owner,
            dependencies,
            type_dependencies,
            aliases: config.aliases,
            import_resolver,
            require_resolver,
            mode,
        })
    }

    fn unlisted(&self, import: &ModuleImport) -> Result<Option<String>, String> {
        let Some(source_name) = specifier_package(import.source) else {
            return Ok(None);
        };
        let accepted = if import.type_only {
            &self.type_dependencies
        } else {
            &self.dependencies
        };
        if !import.source.starts_with('#') && accepted.contains(&source_name) {
            return Ok(None);
        }
        let resolver = match import.mode.unwrap_or(self.mode) {
            ResolutionMode::Import => &self.import_resolver,
            ResolutionMode::Require => &self.require_resolver,
        };
        let parent = self
            .filename
            .parent()
            .ok_or_else(|| format!("No parent directory for '{}'", self.filename.display()))?;
        let resolution = match resolve_dependency(resolver, parent, import.source) {
            Ok(resolution) => resolution,
            Err(ResolveError::Builtin { .. }) => return Ok(None),
            Err(error) if unresolved_module(&error) => {
                let internal = import.source.starts_with('#')
                    || self
                        .aliases
                        .iter()
                        .any(|pattern| specifier_matches(import.source, pattern));
                return Ok((!internal).then_some(source_name));
            }
            Err(error) => {
                return Err(format!(
                    "Cannot resolve '{}' imported by '{}': {error}",
                    import.source,
                    self.filename.display()
                ));
            }
        };
        let target_owner = package_owner(resolution.path())?;
        if let (Some(owner), Some(target)) = (&self.owner, &target_owner)
            && owner.directory == target.directory
        {
            return Ok(None);
        }
        let target_name = target_owner
            .as_ref()
            .and_then(|owner| owner.manifest.name.as_deref());
        let installed = resolution
            .path()
            .components()
            .any(|component| component.as_os_str() == "node_modules");
        if !import.source.starts_with('#')
            && !installed
            && target_name != Some(source_name.as_str())
        {
            return Ok(None);
        }
        let name = if import.source.starts_with('#') {
            imported_name(target_name.ok_or_else(|| {
                format!(
                    "Cannot determine the external package owner for '{}' imported by '{}' from '{}'.",
                    import.source,
                    self.filename.display(),
                    resolution.path().display()
                )
            })?)
        } else {
            source_name
        };
        Ok((!accepted.contains(&name)).then_some(name))
    }
}

fn collect_ancestor_dependencies(
    owner: &PackageOwner,
    dependencies: &mut BTreeSet<String>,
) -> Result<(), String> {
    let mut directory = owner.directory.parent().map(Path::to_path_buf);
    while let Some(parent) = directory {
        let Some(ancestor) = package_owner(&parent.join("__dependency_probe__.js"))? else {
            break;
        };
        if let Some(group) = &ancestor.manifest.dev_dependencies {
            dependencies.extend(group.keys().cloned());
        }
        directory = ancestor.directory.parent().map(Path::to_path_buf);
    }
    Ok(())
}

fn file_resolution_mode(
    filename: &Path,
    owner: Option<&PackageOwner>,
    configured: ResolutionMode,
) -> ResolutionMode {
    match filename
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("cts" | "cjs") => ResolutionMode::Require,
        Some("mts" | "mjs") => ResolutionMode::Import,
        _ => match owner.and_then(|owner| owner.manifest.package_format) {
            Some(PackageFormat::Module) => ResolutionMode::Import,
            Some(PackageFormat::Commonjs) => ResolutionMode::Require,
            None => configured,
        },
    }
}

fn imported_name(package_name: &str) -> String {
    let Some(types_package) = package_name.strip_prefix("@types/") else {
        return package_name.to_owned();
    };
    match types_package.split_once("__") {
        Some((scope, name)) => format!("@{scope}/{name}"),
        None => types_package.to_owned(),
    }
}

fn specifier_package(specifier: &str) -> Option<String> {
    if specifier.starts_with(['.', '/'])
        || specifier.split_once(':').is_some_and(|(scheme, _)| {
            !scheme.is_empty() && scheme.bytes().all(|byte| byte.is_ascii_lowercase())
        })
    {
        return None;
    }
    let count = if specifier.starts_with('@') { 2 } else { 1 };
    Some(
        specifier
            .split('/')
            .take(count)
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn specifier_matches(specifier: &str, pattern: &str) -> bool {
    match pattern.split_once('*') {
        Some((prefix, suffix)) => {
            specifier.len() >= prefix.len() + suffix.len()
                && specifier.starts_with(prefix)
                && specifier.ends_with(suffix)
        }
        None => specifier == pattern,
    }
}
