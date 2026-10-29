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
    #[error("{context}: {source}")]
    GlobCompile {
        context: String,
        #[source]
        source: globset::Error,
    },
}

impl From<KernelError> for String {
    fn from(error: KernelError) -> Self {
        error.to_string()
    }
}
