use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("failed to {operation} {path}: {source}", path = .path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to decode JSON from {location}: {source}")]
    JsonDecode {
        location: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to encode JSON for {location}: {source}")]
    JsonEncode {
        location: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid {key} registry schema in {path}: {source}", path = .path.display())]
    YamlDecode {
        key: String,
        path: PathBuf,
        #[source]
        source: yaml_serde::Error,
    },
    #[error(
        "unknown registry '{stem}' in {path}; valid registries: architecture, boundaries, domain, gateways, generated, react-native",
        path = .path.display()
    )]
    UnknownRegistry { stem: String, path: PathBuf },
    #[error(
        "invalid glob '{pattern}' in {key} registry ({path}): {source}",
        path = .path.display()
    )]
    InvalidRegistryGlob {
        key: &'static str,
        pattern: String,
        path: PathBuf,
        #[source]
        source: globset::Error,
    },
    #[error(
        "invalid options for {rule_name}: this rule takes no options besides files and excludeFiles (got {unexpected})"
    )]
    UnknownRuleOptions {
        rule_name: String,
        unexpected: String,
    },
}

impl From<KernelError> for String {
    fn from(error: KernelError) -> Self {
        error.to_string()
    }
}
