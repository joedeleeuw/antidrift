use serde_json::Value;
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

#[must_use]
pub fn parse_package_json_manifest(source_text: &str) -> Option<PackageJsonManifest> {
    let Ok(Value::Object(root)) = serde_json::from_str(source_text) else {
        return None;
    };
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
    Some(PackageJsonManifest { sections })
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

#[must_use]
pub fn package_entrypoint_paths(pkg_path: &Path) -> Option<Vec<String>> {
    let Ok(text) = std::fs::read_to_string(pkg_path) else {
        return None;
    };
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&text) else {
        return None;
    };
    let mut entries = Vec::new();
    for key in ENTRYPOINT_KEYS {
        if let Some(field) = obj.get(key) {
            collect_json_strings(field, &mut entries);
        }
    }
    Some(entries)
}

#[must_use]
pub fn load_nearest_package_json_manifest(file_path: &Path) -> Option<PackageJsonManifest> {
    let mut current = file_path.parent();
    while let Some(dir) = current {
        let candidate = dir.join("package.json");
        if candidate.is_file() {
            let Ok(text) = std::fs::read_to_string(&candidate) else {
                return None;
            };
            if let Some(manifest) = parse_package_json_manifest(&text) {
                return Some(manifest);
            }
        }
        current = dir.parent();
    }
    None
}
