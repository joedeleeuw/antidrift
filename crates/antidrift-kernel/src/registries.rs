use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const NON_BAG_TYPE_NAMES: &[&str] = &[
    "AbortController",
    "AbortSignal",
    "Array",
    "ArrayBuffer",
    "Blob",
    "Buffer",
    "Checker",
    "CustomEvent",
    "DataView",
    "Date",
    "Document",
    "Element",
    "Error",
    "Event",
    "File",
    "FormData",
    "Function",
    "Headers",
    "HTMLElement",
    "Map",
    "Node",
    "Program",
    "Promise",
    "RangeError",
    "ReadableStream",
    "ReadonlyArray",
    "ReadonlyMap",
    "ReadonlySet",
    "ReferenceError",
    "RegExp",
    "Request",
    "Response",
    "RuleContext",
    "Set",
    "SharedArrayBuffer",
    "Signature",
    "SourceCode",
    "SourceFile",
    "Symbol",
    "SyntaxError",
    "TransformStream",
    "Type",
    "TypeChecker",
    "TypeError",
    "Uint8Array",
    "URL",
    "URLSearchParams",
    "WeakMap",
    "WeakSet",
    "Window",
    "WritableStream",
];

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
    pub raw_registries: BTreeMap<String, Value>,
}

impl PolicyRegistries {
    pub fn load_from_repo(repo_root: &Path) -> Result<Self, String> {
        let registries_dir = repo_root.join("policy").join("registries");
        if !registries_dir.is_dir() {
            return Ok(Self::default());
        }
        let mut raw_registries = BTreeMap::new();
        let entries = fs::read_dir(&registries_dir)
            .map_err(|err| format!("failed to read {}: {err}", registries_dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("yaml") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let text = fs::read_to_string(&path)
                .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
            let value: Value = yaml_serde::from_str(&text)
                .map_err(|err| format!("failed to parse {}: {err}", path.display()))?;
            raw_registries.insert(stem, value);
        }

        let boundaries = decode_registry(&raw_registries, "boundaries")?;
        let domain = decode_registry(&raw_registries, "domain")?;
        let gateways = decode_registry(&raw_registries, "gateways")?;
        let generated = decode_registry(&raw_registries, "generated")?;

        Ok(Self {
            boundaries,
            domain,
            gateways,
            generated,
            raw_registries,
        })
    }
}

fn decode_registry<T: Default + serde::de::DeserializeOwned>(
    raw_registries: &BTreeMap<String, Value>,
    key: &str,
) -> Result<T, String> {
    match raw_registries.get(key) {
        Some(val) => serde_json::from_value(val.clone())
            .map_err(|err| format!("invalid {key} registry schema: {err}")),
        None => Ok(T::default()),
    }
}
