use crate::span_index::FactLocation;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const DROPPED_PAYLOAD_KEYS: &[&str] = &[
    "astNode",
    "checker",
    "fullSource",
    "modelScore",
    "node",
    "program",
    "sourceFile",
    "sourceText",
    "tsNode",
    "tsProgram",
    "tsSymbol",
    "tsType",
    "typeChecker",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticFact {
    pub adapter_id: String,
    pub confidence: String,
    pub evidence_hash: String,
    pub fact_id: String,
    pub fact_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_hash: Option<String>,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<FactLocation>,
    pub payload: Value,
    pub provenance: Vec<String>,
    pub rule_id: String,
    pub schema_version: u32,
}

#[must_use]
pub fn normalize_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(normalize_json_value).collect()),
        Value::Object(map) => {
            let mut sorted_keys: Vec<&String> = map
                .keys()
                .filter(|key| !DROPPED_PAYLOAD_KEYS.contains(&key.as_str()))
                .collect();
            sorted_keys.sort();
            let mut out = Map::new();
            for key in sorted_keys {
                if let Some(child) = map.get(key) {
                    out.insert(key.clone(), normalize_json_value(child));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn semantic_fact_to_json_line(fact: &SemanticFact) -> Result<String, String> {
    let val = serde_json::to_value(fact)
        .map_err(|err| format!("failed to serialize semantic fact {}: {err}", fact.fact_id))?;
    let normalized = normalize_json_value(&val);
    let mut line = normalized.to_string();
    line.push('\n');
    Ok(line)
}
