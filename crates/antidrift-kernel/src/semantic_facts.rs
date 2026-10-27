use crate::span_index::FactLocation;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub const SEMANTIC_FACT_SCHEMA_VERSION: u32 = 1;

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
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone)]
pub struct SemanticFactInput {
    pub fact_kind: String,
    pub rule_id: String,
    pub adapter_id: String,
    pub confidence: String,
    pub provenance: Vec<String>,
    pub file_path: String,
    pub location: Option<FactLocation>,
    pub source_text: Option<String>,
    pub payload: Value,
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

#[must_use]
pub fn sha256_json_digest(value: &Value) -> String {
    let normalized = normalize_json_value(value);
    let serialized = serde_json::to_string(&normalized).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let bytes = hasher.finalize();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[must_use]
pub fn build_semantic_fact(input: SemanticFactInput) -> SemanticFact {
    let payload = normalize_json_value(&input.payload);
    let mut provenance = input.provenance;
    provenance.sort();
    let file_hash = input
        .source_text
        .as_ref()
        .map(|text| sha256_json_digest(&json!({ "text": text })));

    let evidence_seed = json!({
        "adapterId": input.adapter_id,
        "confidence": input.confidence,
        "factKind": input.fact_kind,
        "payload": payload,
        "provenance": provenance,
        "ruleId": input.rule_id,
    });
    let evidence_hash = sha256_json_digest(&evidence_seed);

    let mut fact_id_seed = Map::new();
    fact_id_seed.insert(
        "adapterId".to_string(),
        Value::String(input.adapter_id.clone()),
    );
    fact_id_seed.insert(
        "evidenceHash".to_string(),
        Value::String(evidence_hash.clone()),
    );
    fact_id_seed.insert(
        "factKind".to_string(),
        Value::String(input.fact_kind.clone()),
    );
    fact_id_seed.insert(
        "filePath".to_string(),
        Value::String(input.file_path.clone()),
    );
    if let Some(loc) = input.location
        && let Ok(loc_val) = serde_json::to_value(loc)
    {
        fact_id_seed.insert("location".to_string(), loc_val);
    }
    fact_id_seed.insert("ruleId".to_string(), Value::String(input.rule_id.clone()));
    let fact_id = sha256_json_digest(&Value::Object(fact_id_seed));

    SemanticFact {
        adapter_id: input.adapter_id,
        confidence: input.confidence,
        evidence_hash,
        fact_id,
        fact_kind: input.fact_kind,
        file_hash,
        file_path: input.file_path,
        location: input.location,
        payload,
        provenance,
        rule_id: input.rule_id,
        schema_version: SEMANTIC_FACT_SCHEMA_VERSION,
    }
}

#[must_use]
pub fn semantic_fact_to_json_line(fact: &SemanticFact) -> String {
    let val = serde_json::to_value(fact).unwrap_or(Value::Null);
    let normalized = normalize_json_value(&val);
    let mut line = serde_json::to_string(&normalized).unwrap_or_default();
    line.push('\n');
    line
}
