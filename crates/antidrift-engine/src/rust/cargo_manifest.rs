use super::RustDiagnostic;
use super::config::{AntidriftTable, RustConfig};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use toml::Spanned;

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct CargoManifest {
    pub(super) package: Option<PackageTable>,
    pub(super) workspace: Option<WorkspaceTable>,
    pub(super) lib: Option<Spanned<TargetTable>>,
    pub(super) bin: Vec<Spanned<TargetTable>>,
    pub(super) lints: Option<LintsTable>,
    pub(super) dependencies: BTreeMap<String, toml::Value>,
    #[serde(rename = "dev-dependencies")]
    pub(super) dev_dependencies: BTreeMap<String, toml::Value>,
    #[serde(rename = "build-dependencies")]
    pub(super) build_dependencies: BTreeMap<String, toml::Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct PackageTable {
    pub(super) name: Option<String>,
    pub(super) workspace: Option<String>,
    pub(super) metadata: MetadataTable,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct WorkspaceTable {
    pub(super) members: Vec<String>,
    pub(super) exclude: Vec<String>,
    pub(super) lints: Option<toml::Value>,
    pub(super) dependencies: BTreeMap<String, toml::Value>,
    pub(super) metadata: MetadataTable,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct MetadataTable {
    pub(super) antidrift: Option<AntidriftTable>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct TargetTable {
    pub(super) path: Option<String>,
    pub(super) test: Option<bool>,
    pub(super) doctest: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct LintsTable {
    pub(super) workspace: Option<bool>,
}

pub(super) struct ManifestSource {
    pub(super) path: PathBuf,
    pub(super) manifest: CargoManifest,
    text: String,
}

fn dependency_package_name<'a>(alias: &'a str, spec: &'a toml::Value) -> &'a str {
    match spec {
        toml::Value::Table(detailed) => match detailed.get("package") {
            Some(toml::Value::String(package)) => package.as_str(),
            _ => alias,
        },
        _ => alias,
    }
}

fn dependency_path(spec: &toml::Value) -> Option<&str> {
    match spec {
        toml::Value::Table(detailed) => match detailed.get("path") {
            Some(toml::Value::String(path)) => Some(path.as_str()),
            _ => None,
        },
        _ => None,
    }
}

impl ManifestSource {
    pub(super) fn directory(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    pub(super) fn crate_name(&self) -> Option<&str> {
        self.manifest.package.as_ref()?.name.as_deref()
    }

    pub(super) fn targets(&self) -> impl Iterator<Item = (&'static str, &Spanned<TargetTable>)> {
        self.manifest
            .lib
            .iter()
            .map(|target| ("[lib]", target))
            .chain(self.manifest.bin.iter().map(|target| ("[[bin]]", target)))
    }

    pub(super) fn dependency_names(&self) -> impl Iterator<Item = &str> {
        self.manifest
            .dependencies
            .iter()
            .map(|(alias, spec)| dependency_package_name(alias, spec))
    }

    pub(super) fn dependency_paths(&self) -> Vec<PathBuf> {
        let manifest = &self.manifest;
        let workspace_paths = manifest
            .workspace
            .iter()
            .flat_map(|workspace| workspace.dependencies.values());
        manifest
            .dependencies
            .values()
            .chain(manifest.dev_dependencies.values())
            .chain(manifest.build_dependencies.values())
            .chain(workspace_paths)
            .filter_map(dependency_path)
            .map(|relative| self.directory().join(relative))
            .collect()
    }

    pub(super) fn line_of(&self, byte_offset: usize) -> usize {
        self.text[..byte_offset.min(self.text.len())]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            + 1
    }
}

pub(super) fn read_manifest_source(manifest_path: &Path) -> Result<ManifestSource, String> {
    let text = fs::read_to_string(manifest_path)
        .map_err(|err| format!("failed to read {}: {err}", manifest_path.display()))?;
    let manifest: CargoManifest = toml::from_str(&text)
        .map_err(|err| format!("{}: invalid Cargo manifest: {err}", manifest_path.display()))?;
    Ok(ManifestSource {
        path: manifest_path.to_path_buf(),
        manifest,
        text,
    })
}

pub(super) fn check_cargo_manifest(
    manifest_rel: &str,
    source: &ManifestSource,
    config: &RustConfig,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    for (header, target) in source.targets() {
        let line = source.line_of(target.span().start);
        for (flag, value) in [
            ("test", target.get_ref().test),
            ("doctest", target.get_ref().doctest),
        ] {
            if value != Some(false) {
                diagnostics.push(RustDiagnostic::error(
                    manifest_rel.to_owned(),
                    line,
                    "rust/no-inline-tests",
                    format!(
                        "Section {header} must set `{flag} = false`; validate via real CLI smoke runs instead of cargo test targets."
                    ),
                ));
            }
        }
    }
    if config.workspace_defines_lints
        && source.path != config.manifest_path
        && source
            .manifest
            .lints
            .as_ref()
            .and_then(|lints| lints.workspace)
            != Some(true)
    {
        diagnostics.push(RustDiagnostic::error(
            manifest_rel.to_owned(),
            1,
            "rust/require-workspace-lints",
            format!(
                "The workspace at {} declares [workspace.lints] but this crate does not inherit it; add `[lints] workspace = true` so one lint policy owns every crate.",
                config.manifest_path.display()
            ),
        ));
    }
    let Some(crate_name) = source.crate_name() else {
        return;
    };
    let Some(crate_rank) = config
        .layers
        .crates
        .iter()
        .position(|name| name == crate_name)
    else {
        return;
    };
    for dependency in source.dependency_names() {
        let Some(dependency_rank) = config
            .layers
            .crates
            .iter()
            .position(|name| name == dependency)
        else {
            continue;
        };
        if dependency_rank > crate_rank {
            diagnostics.push(RustDiagnostic::error(
                manifest_rel.to_owned(),
                1,
                "rust/no-layer-violation",
                format!(
                    "Crate '{crate_name}' (layer {crate_rank}) cannot depend on '{dependency}' (layer {dependency_rank}); layers.crates in the antidrift metadata orders crates from lowest to highest."
                ),
            ));
        }
    }
}
