use crate::error::KernelError;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

const ENTRYPOINT_KEYS: [&str; 8] = [
    "exports", "main", "module", "types", "typings", "browser", "bin", "source",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonPropertySpan {
    pub key: String,
    pub string_value: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageJsonManifest {
    pub sections: BTreeMap<String, Vec<JsonPropertySpan>>,
}

pub fn parse_package_json_manifest(source_text: &str) -> Result<PackageJsonManifest, KernelError> {
    let root: Map<String, Value> =
        serde_json::from_str(source_text).map_err(|source| KernelError::JsonDecode {
            location: "package.json source text".to_owned(),
            source,
        })?;
    let mut sections: BTreeMap<String, Vec<JsonPropertySpan>> = BTreeMap::new();
    for (key_name, value) in root {
        let Value::Object(nested) = value else {
            continue;
        };
        let entries = nested
            .into_iter()
            .map(|(dep_name, dep_val)| JsonPropertySpan {
                key: dep_name,
                string_value: dep_val.as_str().map(ToOwned::to_owned),
            })
            .collect();
        sections.insert(key_name, entries);
    }
    Ok(PackageJsonManifest { sections })
}

fn collect_json_strings(val: &Value, out: &mut Vec<String>) {
    match val {
        Value::String(s) => out.push(s.clone()),
        Value::Array(arr) => {
            for item in arr {
                collect_json_strings(item, out);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_json_strings(item, out);
            }
        }
        _ => {}
    }
}

pub fn package_entrypoint_paths(pkg_path: &Path) -> Result<Vec<String>, KernelError> {
    let text = std::fs::read_to_string(pkg_path).map_err(|source| KernelError::Io {
        operation: "read",
        path: pkg_path.to_path_buf(),
        source,
    })?;
    let obj: Map<String, Value> =
        serde_json::from_str(&text).map_err(|source| KernelError::JsonDecode {
            location: pkg_path.display().to_string(),
            source,
        })?;
    let mut entries = Vec::new();
    for key in ENTRYPOINT_KEYS {
        if let Some(field) = obj.get(key) {
            collect_json_strings(field, &mut entries);
        }
    }
    Ok(entries)
}

pub fn load_nearest_package_json_manifest(
    file_path: &Path,
) -> Result<Option<PackageJsonManifest>, KernelError> {
    let mut current = file_path.parent();
    while let Some(dir) = current {
        let candidate = dir.join("package.json");
        if candidate.is_file() {
            let text = std::fs::read_to_string(&candidate).map_err(|source| KernelError::Io {
                operation: "read",
                path: candidate.clone(),
                source,
            })?;
            return parse_package_json_manifest(&text).map(Some);
        }
        current = dir.parent();
    }
    Ok(None)
}
