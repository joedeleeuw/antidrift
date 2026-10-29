use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedUnionStatus {
    pub owner: String,
    #[serde(default)]
    pub values_export: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainRegistry {
    #[serde(default)]
    pub canonical_entities: BTreeMap<String, String>,
    #[serde(default)]
    pub statuses: BTreeMap<String, OwnedUnionStatus>,
    #[serde(default)]
    pub roles: Option<OwnedUnionStatus>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedGateway {
    pub wrapper: String,
    #[serde(default)]
    pub banned_direct_imports: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaysRegistry {
    #[serde(default)]
    pub approved_gateways: BTreeMap<String, ApprovedGateway>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedSourceEntry {
    pub generated: String,
    #[serde(default)]
    pub wrapper: String,
    #[serde(default)]
    pub banned_direct_imports: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedRegistry {
    #[serde(default)]
    pub generated_sources: BTreeMap<String, GeneratedSourceEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundariesRegistry {
    #[serde(default)]
    pub server_boundary_globs: Vec<String>,
    #[serde(default)]
    pub required_calls: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyRegistries {
    pub boundaries: BoundariesRegistry,
    pub domain: DomainRegistry,
    pub gateways: GatewaysRegistry,
    pub generated: GeneratedRegistry,
}

impl PolicyRegistries {
    pub fn load_from_repo(repo_root: &Path) -> Result<Self, String> {
        let registries_dir = repo_root.join("policy").join("registries");
        if !registries_dir.is_dir() {
            return Ok(Self::default());
        }
        let mut registries = Self::default();
        let entries = fs::read_dir(&registries_dir)
            .map_err(|err| format!("failed to read {}: {err}", registries_dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("yaml") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let text = fs::read_to_string(&path)
                .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
            match stem {
                "boundaries" => {
                    registries.boundaries = decode_yaml_registry(&path, "boundaries", &text)?;
                }
                "domain" => {
                    registries.domain = decode_yaml_registry(&path, "domain", &text)?;
                }
                "gateways" => {
                    registries.gateways = decode_yaml_registry(&path, "gateways", &text)?;
                }
                "generated" => {
                    registries.generated = decode_yaml_registry(&path, "generated", &text)?;
                }
                _ => {
                    let _: serde::de::IgnoredAny = yaml_serde::from_str(&text)
                        .map_err(|err| format!("failed to parse {}: {err}", path.display()))?;
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
) -> Result<T, String> {
    yaml_serde::from_str(text)
        .map_err(|err| format!("invalid {key} registry schema in {}: {err}", path.display()))
}
