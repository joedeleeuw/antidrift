use crate::error::KernelError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

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
    server_boundary_globs: Vec<String>,
    #[serde(default)]
    required_calls: BTreeMap<String, Vec<String>>,
}

fn deserialize_generated_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized
        .strip_prefix("./")
        .unwrap_or(&normalized)
        .trim_end_matches('/');
    if trimmed.is_empty()
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || trimmed.contains(['!', '*', '?', '{', '}', '(', ')', '[', ']'])
        || trimmed
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(serde::de::Error::custom(
            "generated must be a non-empty repo-relative path without globs or '..'",
        ));
    }
    Ok(trimmed.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedSource {
    #[serde(deserialize_with = "deserialize_generated_path")]
    generated: String,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    wrapper: Option<String>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    banned_direct_imports: Vec<String>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedFile {
    #[serde(default)]
    generated_sources: BTreeMap<String, GeneratedSource>,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyRegistries {
    pub server_boundary_globs: Vec<String>,
    pub required_calls: BTreeMap<String, Vec<String>>,
    pub statuses: BTreeMap<String, OwnedUnion>,
    pub generated_paths: Vec<PathBuf>,
}

impl PolicyRegistries {
    pub fn load_from_repo(repo_root: &Path) -> Result<Self, KernelError> {
        let Some((owner_root, registries_dir)) = repo_root
            .ancestors()
            .map(|ancestor| (ancestor, ancestor.join("policy").join("registries")))
            .find(|(_, candidate)| candidate.is_dir())
        else {
            return Ok(Self::default());
        };
        let owner_norm = clean_lexical_path(owner_root);
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
                    registries.server_boundary_globs = parsed.server_boundary_globs;
                    registries.required_calls = parsed.required_calls;
                }
                "domain" => {
                    let parsed: DomainFile = decode_yaml_registry(&path, "domain", &text)?;
                    registries.statuses = parsed.statuses;
                }
                "generated" => {
                    let parsed: GeneratedFile = decode_yaml_registry(&path, "generated", &text)?;
                    registries.generated_paths.extend(
                        parsed
                            .generated_sources
                            .into_values()
                            .map(|source| owner_norm.join(source.generated)),
                    );
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

    #[must_use]
    pub fn is_generated_path(&self, path: &Path) -> bool {
        if self.generated_paths.is_empty() {
            return false;
        }
        let cleaned = clean_lexical_path(path);
        self.generated_paths
            .iter()
            .any(|generated| cleaned.starts_with(generated))
    }
}

fn clean_lexical_path(path: &Path) -> PathBuf {
    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                cleaned.pop();
            }
            other => cleaned.push(other.as_os_str()),
        }
    }
    cleaned
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
