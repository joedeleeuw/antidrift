use super::package_ownership::absolute_filename;
use antidrift_kernel::ts_resolver::{
    ResolutionMode, TsDeclarationResolver, definitely_typed_specifier,
};
use oxc_resolver::{
    Resolution, ResolveError, ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions,
    TsconfigReferences,
};
use std::path::Path;

pub(super) fn resolver_with_mode(
    filename: &Path,
    mode: ResolutionMode,
) -> Result<Resolver, String> {
    let abs_filename = absolute_filename(filename)?;
    let tsconfig_path = TsDeclarationResolver::discover_governing_tsconfig(&abs_filename);
    let condition = match mode {
        ResolutionMode::Import => "import",
        ResolutionMode::Require => "require",
    };
    let options = ResolveOptions {
        tsconfig: tsconfig_path.clone().map(|config_file| {
            TsconfigDiscovery::Manual(TsconfigOptions {
                config_file,
                references: TsconfigReferences::Auto,
            })
        }),
        builtin_modules: true,
        condition_names: ["types", condition, "node", "default"]
            .map(str::to_owned)
            .to_vec(),
        main_fields: ["types", "typings", "module", "main"]
            .map(str::to_owned)
            .to_vec(),
        extensions: [
            ".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts", ".js", ".jsx", ".mjs",
            ".cjs", ".json",
        ]
        .map(str::to_owned)
        .to_vec(),
        extension_alias: vec![
            (
                ".js".to_owned(),
                [".ts", ".tsx", ".d.ts", ".js"].map(str::to_owned).to_vec(),
            ),
            (
                ".mjs".to_owned(),
                [".mts", ".d.mts", ".mjs"].map(str::to_owned).to_vec(),
            ),
            (
                ".cjs".to_owned(),
                [".cts", ".d.cts", ".cjs"].map(str::to_owned).to_vec(),
            ),
        ],
        ..ResolveOptions::default()
    };
    let resolver = Resolver::new(options);
    if let Some(config_path) = tsconfig_path {
        resolver.resolve_tsconfig(&config_path).map_err(|error| {
            format!(
                "Invalid module-resolution config '{}': {error}",
                config_path.display()
            )
        })?;
    }
    Ok(resolver)
}

pub(super) struct ModuleResolutionConfig {
    pub(super) aliases: Vec<String>,
    pub(super) default_mode: ResolutionMode,
}

pub(super) fn resolution_config(
    filename: &Path,
    resolver: &Resolver,
) -> Result<ModuleResolutionConfig, String> {
    let abs_filename = absolute_filename(filename)?;
    let Some(config_path) = TsDeclarationResolver::discover_governing_tsconfig(&abs_filename)
    else {
        return Ok(ModuleResolutionConfig {
            aliases: Vec::new(),
            default_mode: ResolutionMode::Require,
        });
    };
    let config = resolver.resolve_tsconfig(&config_path).map_err(|error| {
        format!(
            "Invalid module-resolution config '{}': {error}",
            config_path.display()
        )
    })?;
    let aliases = config
        .compiler_options
        .paths
        .as_ref()
        .map_or_else(Vec::new, |paths| paths.keys().cloned().collect());
    let module = config
        .compiler_options
        .module
        .as_deref()
        .map(str::to_ascii_lowercase);
    let default_mode = match module.as_deref() {
        Some("es6" | "es2015" | "es2020" | "es2022" | "esnext" | "preserve") => {
            ResolutionMode::Import
        }
        _ => ResolutionMode::Require,
    };
    Ok(ModuleResolutionConfig {
        aliases,
        default_mode,
    })
}

pub(super) fn resolve_dependency(
    resolver: &Resolver,
    containing_directory: &Path,
    specifier: &str,
) -> Result<Resolution, ResolveError> {
    let error = match resolver.resolve(containing_directory, specifier) {
        Ok(resolution) => return Ok(resolution),
        Err(error) => error,
    };
    let ResolveError::NotFound(missing) = &error else {
        return Err(error);
    };
    let Some(type_provider) = definitely_typed_specifier(missing) else {
        return Err(error);
    };
    if *missing == type_provider {
        return Err(error);
    }
    match resolver.resolve(containing_directory, &type_provider) {
        Err(provider_error) if unresolved_module(&provider_error) => Err(error),
        resolution => resolution,
    }
}

pub(super) fn unresolved_module(error: &ResolveError) -> bool {
    matches!(
        error,
        ResolveError::NotFound(_)
            | ResolveError::MatchedAliasNotFound(_, _)
            | ResolveError::ExtensionAlias(_, _, _)
            | ResolveError::PackagePathNotExported { .. }
            | ResolveError::PackageImportNotDefined(_, _)
    )
}
