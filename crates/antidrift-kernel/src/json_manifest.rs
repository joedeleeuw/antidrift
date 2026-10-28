use serde_json::Value;
use std::collections::BTreeMap;

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
