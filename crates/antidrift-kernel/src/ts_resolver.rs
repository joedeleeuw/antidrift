use oxc_resolver::{
    EnforceExtension, ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions,
    TsconfigReferences,
};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionMode {
    Import,
    Require,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTypeTarget {
    pub path: PathBuf,
    pub package_name: Option<String>,
    pub from_definitely_typed: bool,
}

pub struct TsDeclarationResolver {
    import_resolver: Resolver,
    require_resolver: Resolver,
}

impl TsDeclarationResolver {
    #[must_use]
    pub fn new(tsconfig_path: Option<PathBuf>) -> Self {
        let import_resolver = Resolver::new(build_resolve_options(
            tsconfig_path.clone(),
            ResolutionMode::Import,
        ));
        let require_resolver = Resolver::new(build_resolve_options(
            tsconfig_path,
            ResolutionMode::Require,
        ));
        Self {
            import_resolver,
            require_resolver,
        }
    }

    #[must_use]
    pub fn discover_governing_tsconfig(file_path: &Path) -> Option<PathBuf> {
        let mut cursor = if file_path.is_dir() {
            Some(file_path)
        } else {
            file_path.parent()
        };
        while let Some(dir) = cursor {
            let candidate = dir.join("tsconfig.json");
            if candidate.is_file() {
                return Some(candidate);
            }
            cursor = dir.parent();
        }
        None
    }

    #[must_use]
    pub fn mode_for_file(file_path: &Path, is_require_call: bool) -> ResolutionMode {
        if is_require_call {
            return ResolutionMode::Require;
        }
        if let Some(name) = file_path.file_name().and_then(|n| n.to_str())
            && (name.ends_with(".cts") || name.ends_with(".cjs"))
        {
            return ResolutionMode::Require;
        }
        ResolutionMode::Import
    }

    #[must_use]
    pub fn resolve_declaration(
        &self,
        containing_dir: &Path,
        specifier: &str,
        mode: ResolutionMode,
    ) -> Option<ResolvedTypeTarget> {
        let resolver = match mode {
            ResolutionMode::Import => &self.import_resolver,
            ResolutionMode::Require => &self.require_resolver,
        };
        if let Ok(resolution) = resolver.resolve(containing_dir, specifier) {
            let resolved_path = resolution.full_path();
            if is_type_or_source_file(&resolved_path) {
                return Some(ResolvedTypeTarget {
                    path: resolved_path,
                    package_name: bare_package_name(specifier),
                    from_definitely_typed: false,
                });
            }
            if let Some(dts_sibling) = sibling_dts_for_js(&resolved_path) {
                return Some(ResolvedTypeTarget {
                    path: dts_sibling,
                    package_name: bare_package_name(specifier),
                    from_definitely_typed: false,
                });
            }
        }
        let dt_specifier = definitely_typed_specifier(specifier)?;
        let resolution = resolver.resolve(containing_dir, &dt_specifier).ok()?;
        let resolved_path = resolution.full_path();
        if is_type_or_source_file(&resolved_path) {
            return Some(ResolvedTypeTarget {
                path: resolved_path,
                package_name: Some(dt_specifier),
                from_definitely_typed: true,
            });
        }
        None
    }
}

#[must_use]
pub fn bare_package_name(specifier: &str) -> Option<String> {
    if specifier.starts_with('.') || specifier.starts_with('/') || specifier.starts_with('#') {
        return None;
    }
    if let Some(rest) = specifier.strip_prefix('@') {
        let mut parts = rest.splitn(3, '/');
        let scope = parts.next()?;
        let name = parts.next()?;
        if scope.is_empty() || name.is_empty() {
            return None;
        }
        return Some(format!("@{scope}/{name}"));
    }
    let pkg = specifier.split('/').next()?;
    (!pkg.is_empty()).then(|| pkg.to_string())
}

#[must_use]
pub fn definitely_typed_specifier(specifier: &str) -> Option<String> {
    let pkg = bare_package_name(specifier)?;
    if pkg.starts_with("@types/") {
        return Some(pkg);
    }
    let dt_pkg = if let Some(scoped) = pkg.strip_prefix('@') {
        let (scope, name) = scoped.split_once('/')?;
        format!("@types/{scope}__{name}")
    } else {
        format!("@types/{pkg}")
    };
    let subpath = specifier.strip_prefix(&pkg).unwrap_or("");
    Some(format!("{dt_pkg}{subpath}"))
}

fn build_resolve_options(tsconfig_path: Option<PathBuf>, mode: ResolutionMode) -> ResolveOptions {
    let condition_names = match mode {
        ResolutionMode::Import => vec![
            "types".to_string(),
            "import".to_string(),
            "default".to_string(),
        ],
        ResolutionMode::Require => vec![
            "types".to_string(),
            "require".to_string(),
            "default".to_string(),
        ],
    };
    let tsconfig = tsconfig_path.map(|config_file| {
        TsconfigDiscovery::Manual(TsconfigOptions {
            config_file,
            references: TsconfigReferences::Auto,
        })
    });
    ResolveOptions {
        tsconfig,
        condition_names,
        extension_alias: vec![
            (
                ".js".to_string(),
                vec![
                    ".ts".to_string(),
                    ".tsx".to_string(),
                    ".d.ts".to_string(),
                    ".js".to_string(),
                ],
            ),
            (
                ".mjs".to_string(),
                vec![".mts".to_string(), ".d.mts".to_string(), ".mjs".to_string()],
            ),
            (
                ".cjs".to_string(),
                vec![".cts".to_string(), ".d.cts".to_string(), ".cjs".to_string()],
            ),
        ],
        extensions: vec![
            ".ts".to_string(),
            ".tsx".to_string(),
            ".d.ts".to_string(),
            ".mts".to_string(),
            ".d.mts".to_string(),
            ".cts".to_string(),
            ".d.cts".to_string(),
            ".js".to_string(),
            ".jsx".to_string(),
            ".mjs".to_string(),
            ".cjs".to_string(),
            ".json".to_string(),
        ],
        main_fields: vec![
            "types".to_string(),
            "typings".to_string(),
            "module".to_string(),
            "main".to_string(),
        ],
        enforce_extension: EnforceExtension::Disabled,
        ..ResolveOptions::default()
    }
}

fn is_type_or_source_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".d.ts")
        || name.ends_with(".d.mts")
        || name.ends_with(".d.cts")
        || name.ends_with(".ts")
        || name.ends_with(".tsx")
        || name.ends_with(".mts")
        || name.ends_with(".cts")
}

fn sibling_dts_for_js(path: &Path) -> Option<PathBuf> {
    let path_str = path.to_str()?;
    for (js_ext, dts_ext) in [
        (".mjs", ".d.mts"),
        (".cjs", ".d.cts"),
        (".jsx", ".d.ts"),
        (".js", ".d.ts"),
    ] {
        if let Some(stem) = path_str.strip_suffix(js_ext) {
            let candidate = PathBuf::from(format!("{stem}{dts_ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
