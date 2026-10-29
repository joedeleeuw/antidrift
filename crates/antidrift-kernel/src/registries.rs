use crate::error::KernelError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedUnion {
    pub owner: String,
    #[serde(default)]
    pub values_export: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomainFile {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    canonical_entities: BTreeMap<String, String>,
    #[serde(default)]
    statuses: BTreeMap<String, OwnedUnion>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    roles: Option<OwnedUnion>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundariesFile {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    server_boundary_globs: Vec<String>,
    #[serde(default)]
    required_calls: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyRegistries {
    pub required_calls: BTreeMap<String, Vec<String>>,
    pub statuses: BTreeMap<String, OwnedUnion>,
}

impl PolicyRegistries {
    pub fn load_from_repo(repo_root: &Path) -> Result<Self, KernelError> {
        let registries_dir = repo_root.join("policy").join("registries");
        if !registries_dir.is_dir() {
            return Ok(Self::default());
        }
        let mut registries = Self::default();
        let entries = fs::read_dir(&registries_dir).map_err(|source| KernelError::Io {
            operation: "read directory",
            path: registries_dir.clone(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| KernelError::Io {
                operation: "read directory entry in",
                path: registries_dir.clone(),
                source,
            })?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("yaml") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let text = fs::read_to_string(&path).map_err(|source| KernelError::Io {
                operation: "read",
                path: path.clone(),
                source,
            })?;
            match stem {
                "boundaries" => {
                    let parsed: BoundariesFile = decode_yaml_registry(&path, "boundaries", &text)?;
                    registries.required_calls = parsed.required_calls;
                }
                "domain" => {
                    let parsed: DomainFile = decode_yaml_registry(&path, "domain", &text)?;
                    registries.statuses = parsed.statuses;
                }
                _ => {
                    let _: serde::de::IgnoredAny =
                        yaml_serde::from_str(&text).map_err(|source| KernelError::YamlDecode {
                            key: stem.to_owned(),
                            path: path.clone(),
                            source,
                        })?;
                }
            }
        }

        Ok(registries)
    }
}

fn decode_yaml_registry<T: serde::de::DeserializeOwned>(
    path: &Path,
    key: &str,
    text: &str,
) -> Result<T, KernelError> {
    yaml_serde::from_str(text).map_err(|source| KernelError::YamlDecode {
        key: key.to_owned(),
        path: path.to_path_buf(),
        source,
    })
}
