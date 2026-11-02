use crate::error::KernelError;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tsrs_core::tspath;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedUnion {
    pub owner: String,
    #[serde(default)]
    pub values_export: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayerRole {
    Domain,
    Boundary,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchitectureLayer {
    pub roots: Vec<String>,
    #[serde(default)]
    pub may_import: Vec<String>,
    #[serde(default)]
    pub role: Option<LayerRole>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchitectureFile {
    #[serde(default)]
    layers: BTreeMap<String, ArchitectureLayer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DomainFile {
    #[serde(default)]
    statuses: BTreeMap<String, OwnedUnion>,
    #[serde(default)]
    roles: Option<OwnedUnion>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequiredCallsFile {
    #[serde(default)]
    authorization: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundariesFile {
    #[serde(default)]
    server_boundary_globs: Vec<String>,
    #[serde(default)]
    required_calls: RequiredCallsFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovedGateway {
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    wrapper: String,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    banned_direct_imports: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GatewaysFile {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    approved_gateways: BTreeMap<String, ApprovedGateway>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReactNativeFile {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    replacement_import: Option<String>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "validated at YAML boundary via deny_unknown_fields"
    )]
    allowed_files: Vec<String>,
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
    pub owner_root: Option<String>,
    pub server_boundary_globs: Vec<String>,
    pub required_calls: BTreeMap<String, Vec<String>>,
    pub statuses: BTreeMap<String, OwnedUnion>,
    pub generated_paths: Vec<PathBuf>,
    pub generated_rel_paths: Vec<String>,
    pub domain_globs: Option<GlobSet>,
    pub boundary_globs: Option<GlobSet>,
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
        let mut registries = Self {
            owner_root: Some(tspath::normalize_slashes(&owner_norm.to_string_lossy())),
            ..Self::default()
        };
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
            registries.load_registry_file(stem, &path, &text, &owner_norm)?;
        }

        Ok(registries)
    }

    fn load_registry_file(
        &mut self,
        stem: &str,
        path: &Path,
        text: &str,
        owner_norm: &Path,
    ) -> Result<(), KernelError> {
        match stem {
            "architecture" => {
                let parsed: ArchitectureFile = decode_yaml_registry(path, "architecture", text)?;
                self.domain_globs = compile_layer_globs(path, &parsed.layers, LayerRole::Domain)?;
                self.boundary_globs =
                    compile_layer_globs(path, &parsed.layers, LayerRole::Boundary)?;
            }
            "boundaries" => {
                let parsed: BoundariesFile = decode_yaml_registry(path, "boundaries", text)?;
                self.server_boundary_globs = parsed.server_boundary_globs;
                if !parsed.required_calls.authorization.is_empty() {
                    self.required_calls.insert(
                        String::from("authorization"),
                        parsed.required_calls.authorization,
                    );
                }
            }
            "domain" => {
                let parsed: DomainFile = decode_yaml_registry(path, "domain", text)?;
                self.statuses = parsed.statuses;
                if let Some(roles) = parsed.roles {
                    self.statuses.entry(String::from("Role")).or_insert(roles);
                }
            }
            "gateways" => {
                drop(decode_yaml_registry::<GatewaysFile>(
                    path, "gateways", text,
                )?);
            }
            "generated" => {
                let parsed: GeneratedFile = decode_yaml_registry(path, "generated", text)?;
                for source in parsed.generated_sources.into_values() {
                    self.generated_paths
                        .push(owner_norm.join(&source.generated));
                    self.generated_rel_paths.push(source.generated);
                }
            }
            "react-native" => {
                drop(decode_yaml_registry::<ReactNativeFile>(
                    path,
                    "react-native",
                    text,
                )?);
            }
            _ => {
                return Err(KernelError::UnknownRegistry {
                    stem: stem.to_owned(),
                    path: path.to_path_buf(),
                });
            }
        }
        Ok(())
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

    #[must_use]
    pub fn is_generated_rel_path(&self, rel_path: &str) -> bool {
        let trimmed = rel_path.trim_start_matches("./").trim_end_matches('/');
        self.generated_rel_paths.iter().any(|generated| {
            trimmed == generated
                || trimmed
                    .strip_prefix(generated.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    #[must_use]
    pub fn is_domain_rel_path(&self, rel_path: &str) -> bool {
        self.domain_globs
            .as_ref()
            .is_some_and(|set| set.is_match(rel_path))
    }

    #[must_use]
    pub fn is_boundary_rel_path(&self, rel_path: &str) -> bool {
        self.boundary_globs
            .as_ref()
            .is_some_and(|set| set.is_match(rel_path))
    }
}

fn compile_layer_globs(
    path: &Path,
    layers: &BTreeMap<String, ArchitectureLayer>,
    role: LayerRole,
) -> Result<Option<GlobSet>, KernelError> {
    let mut builder = GlobSetBuilder::new();
    let mut has_any = false;
    for layer in layers.values().filter(|layer| layer.role == Some(role)) {
        for pattern in &layer.roots {
            let glob = GlobBuilder::new(pattern)
                .literal_separator(true)
                .build()
                .map_err(|source| KernelError::InvalidRegistryGlob {
                    key: "architecture",
                    pattern: pattern.clone(),
                    path: path.to_path_buf(),
                    source,
                })?;
            builder.add(glob);
            has_any = true;
        }
    }
    if !has_any {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|source| KernelError::InvalidRegistryGlob {
            key: "architecture",
            pattern: String::from("*"),
            path: path.to_path_buf(),
            source,
        })
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
