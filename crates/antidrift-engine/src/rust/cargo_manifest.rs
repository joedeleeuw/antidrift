use super::RustDiagnostic;
use super::config::{AntidriftTable, RustConfig};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use toml::Spanned;

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct CargoManifest {
    pub(super) package: Option<PackageTable>,
    pub(super) workspace: Option<WorkspaceTable>,
    pub(super) lib: Option<Spanned<TargetTable>>,
    pub(super) bin: Vec<Spanned<TargetTable>>,
    pub(super) dependencies: BTreeMap<String, toml::Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct PackageTable {
    pub(super) name: Option<String>,
    pub(super) metadata: MetadataTable,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct WorkspaceTable {
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

pub(super) struct ManifestSource {
    pub(super) manifest: CargoManifest,
    text: String,
}

impl ManifestSource {
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
            .map(|(alias, spec)| match spec {
                toml::Value::Table(detailed) => match detailed.get("package") {
                    Some(toml::Value::String(package)) => package.as_str(),
                    _ => alias.as_str(),
                },
                _ => alias.as_str(),
            })
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
    Ok(ManifestSource { manifest, text })
}

pub(super) fn read_manifest(manifest_path: &Path) -> Result<CargoManifest, String> {
    Ok(read_manifest_source(manifest_path)?.manifest)
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
