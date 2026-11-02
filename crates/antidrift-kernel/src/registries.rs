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
    wrapper: String,
    #[serde(default)]
    banned_direct_imports: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GatewaysFile {
    #[serde(default)]
    approved_gateways: BTreeMap<String, ApprovedGateway>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReactNativeFile {
    #[serde(default)]
    replacement_import: Option<String>,
    #[serde(default)]
    allowed_files: Vec<String>,
}

fn deserialize_generated_path<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let norm = String::deserialize(d)?.replace('\\', "/");
    let rel = norm
        .strip_prefix("./")
        .unwrap_or(&norm)
        .trim_end_matches('/');
    let bad_seg = rel
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..");
    let bad_char = rel.contains(['!', '*', '?', '{', '}', '(', ')', '[', ']']);
    if rel.is_empty()
        || norm.starts_with('/')
        || norm.as_bytes().get(1) == Some(&b':')
        || bad_char
        || bad_seg
    {
        return Err(serde::de::Error::custom(
            "generated must be a non-empty repo-relative path without globs or '..'",
        ));
    }
    Ok(rel.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedSource {
    #[serde(deserialize_with = "deserialize_generated_path")]
    generated: String,
    #[serde(default)]
    wrapper: Option<String>,
    #[serde(default)]
    banned_direct_imports: Vec<String>,
    #[serde(default)]
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

const REGISTRIES: [&str; 6] = [
    "architecture",
    "boundaries",
    "domain",
    "gateways",
    "generated",
    "react-native",
];

fn io_err(operation: &'static str, path: &Path, source: std::io::Error) -> KernelError {
    KernelError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn yaml_registry_paths(dir: &Path) -> Result<Vec<PathBuf>, KernelError> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| io_err("read directory", dir, e))? {
        let path = entry
            .map_err(|e| io_err("read directory entry in", dir, e))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("yaml") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

impl PolicyRegistries {
    pub fn load_from_repo(repo_root: &Path) -> Result<Self, KernelError> {
        let Some((owner_root, registries_dir)) = repo_root
            .ancestors()
            .map(|a| (a, a.join("policy").join("registries")))
            .find(|(_, c)| c.is_dir())
        else {
            return Ok(Self::default());
        };
        let owner_norm = clean_lexical_path(owner_root);
        let mut registries = Self {
            owner_root: Some(tspath::normalize_slashes(&owner_norm.to_string_lossy())),
            ..Self::default()
        };
        for path in yaml_registry_paths(&registries_dir)? {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            drop(registries.load_registry_file(stem, &path, &owner_norm)?);
        }
        Ok(registries)
    }

    #[must_use]
    pub fn validate_policy_dir(owner_root: &Path, policy_dir: &Path) -> Vec<String> {
        let Ok(paths) = yaml_registry_paths(&policy_dir.join("registries")) else {
            return Vec::new();
        };
        let owner_norm = clean_lexical_path(owner_root);
        let mut registries = Self::default();
        let mut errors = Vec::new();
        for path in paths {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if !REGISTRIES.contains(&stem) {
                let allowed = REGISTRIES.join(", ");
                errors.push(format!(
                    "policy/registries/{name} has no registered reader (allowed: {allowed})."
                ));
                continue;
            }
            match registries.load_registry_file(stem, &path, &owner_norm) {
                Ok(errs) => errors.extend(errs),
                Err(err) => errors.push(err.to_string()),
            }
        }
        errors
    }

    fn load_registry_file(
        &mut self,
        stem: &str,
        path: &Path,
        owner_norm: &Path,
    ) -> Result<Vec<String>, KernelError> {
        let mut errors = Vec::new();
        match stem {
            "architecture" => {
                let parsed: ArchitectureFile = decode_yaml_registry(path, "architecture")?;
                check_layers(&parsed.layers, &mut errors);
                self.domain_globs = compile_layer_globs(path, &parsed.layers, LayerRole::Domain)?;
                self.boundary_globs =
                    compile_layer_globs(path, &parsed.layers, LayerRole::Boundary)?;
            }
            "boundaries" => {
                let parsed: BoundariesFile = decode_yaml_registry(path, "boundaries")?;
                self.server_boundary_globs = parsed.server_boundary_globs;
                let auth = parsed.required_calls.authorization;
                if !auth.is_empty() {
                    self.required_calls
                        .insert(String::from("authorization"), auth);
                }
            }
            "domain" => {
                let parsed: DomainFile = decode_yaml_registry(path, "domain")?;
                self.load_domain(owner_norm, parsed, &mut errors);
            }
            "gateways" => {
                let parsed: GatewaysFile = decode_yaml_registry(path, "gateways")?;
                check_gateways(owner_norm, &parsed, &mut errors);
            }
            "generated" => {
                let parsed: GeneratedFile = decode_yaml_registry(path, "generated")?;
                self.load_generated_sources(owner_norm, parsed, &mut errors);
            }
            "react-native" => {
                let parsed: ReactNativeFile = decode_yaml_registry(path, "react-native")?;
                if parsed
                    .replacement_import
                    .is_some_and(|r| r.trim().is_empty())
                {
                    errors.push(String::from("react-native.yaml replacementImport empty."));
                }
                for file in &parsed.allowed_files {
                    check_path(owner_norm, file, "react-native.yaml", &mut errors);
                }
            }
            _ => {
                return Err(KernelError::UnknownRegistry {
                    stem: stem.to_owned(),
                    path: path.to_path_buf(),
                });
            }
        }
        Ok(errors)
    }

    fn load_domain(&mut self, root: &Path, parsed: DomainFile, errs: &mut Vec<String>) {
        for (name, entry) in &parsed.statuses {
            check_owned_union(root, &format!("domain.yaml statuses.{name}"), entry, errs);
        }
        self.statuses = parsed.statuses;
        if let Some(roles) = parsed.roles {
            check_owned_union(root, "domain.yaml roles", &roles, errs);
            self.statuses.entry(String::from("Role")).or_insert(roles);
        }
    }

    fn load_generated_sources(
        &mut self,
        root: &Path,
        parsed: GeneratedFile,
        errs: &mut Vec<String>,
    ) {
        for (name, src) in parsed.generated_sources {
            let key = format!("generated.yaml generatedSources.{name}");
            check_path(root, &src.generated, &key, errs);
            if let Some(w) = &src.wrapper {
                check_path(root, w, &key, errs);
            }
            if src.banned_direct_imports.iter().any(String::is_empty)
                || src.message.as_ref().is_some_and(|m| m.trim().is_empty())
            {
                errs.push(format!("policy/registries/{key} has empty string."));
            }
            self.generated_paths.push(root.join(&src.generated));
            self.generated_rel_paths.push(src.generated);
        }
    }

    #[must_use]
    pub fn is_generated_path(&self, path: &Path) -> bool {
        !self.generated_paths.is_empty() && {
            let cleaned = clean_lexical_path(path);
            self.generated_paths.iter().any(|g| cleaned.starts_with(g))
        }
    }

    #[must_use]
    pub fn is_generated_rel_path(&self, rel_path: &str) -> bool {
        let trimmed = rel_path.trim_start_matches("./").trim_end_matches('/');
        self.generated_rel_paths.iter().any(|g| {
            trimmed == g
                || trimmed
                    .strip_prefix(g.as_str())
                    .is_some_and(|r| r.starts_with('/'))
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

fn glob_err(path: &Path, pattern: &str, source: globset::Error) -> KernelError {
    KernelError::InvalidRegistryGlob {
        key: "architecture",
        pattern: pattern.to_owned(),
        path: path.to_path_buf(),
        source,
    }
}

fn compile_layer_globs(
    path: &Path,
    layers: &BTreeMap<String, ArchitectureLayer>,
    role: LayerRole,
) -> Result<Option<GlobSet>, KernelError> {
    let mut builder = GlobSetBuilder::new();
    let mut has_any = false;
    for pat in layers
        .values()
        .filter(|l| l.role == Some(role))
        .flat_map(|l| &l.roots)
    {
        let glob = GlobBuilder::new(pat)
            .literal_separator(true)
            .build()
            .map_err(|e| glob_err(path, pat, e))?;
        builder.add(glob);
        has_any = true;
    }
    if !has_any {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| glob_err(path, "*", e))
}

fn clean_lexical_path(path: &Path) -> PathBuf {
    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => drop(cleaned.pop()),
            other => cleaned.push(other.as_os_str()),
        }
    }
    cleaned
}

fn check_path(root: &Path, rel: &str, label: &str, errs: &mut Vec<String>) {
    if rel.is_empty() || !root.join(rel).exists() {
        errs.push(format!("policy/registries/{label} missing path: {rel}"));
    }
}

fn check_owned_union(root: &Path, label: &str, entry: &OwnedUnion, errs: &mut Vec<String>) {
    check_path(root, &entry.owner, label, errs);
    if entry.values.is_empty() {
        errs.push(format!("policy/registries/{label}.values is empty."));
    }
    let Some(exp) = &entry.values_export else {
        return;
    };
    match fs::read_to_string(root.join(&entry.owner)) {
        Ok(src) if !src.contains(&format!("export const {exp}")) => {
            errs.push(format!("policy/registries/{label} missing export {exp}."));
        }
        Ok(_) => {}
        Err(err) => errs.push(format!("policy/registries/{label}.owner unreadable: {err}")),
    }
}

fn check_layers(layers: &BTreeMap<String, ArchitectureLayer>, errs: &mut Vec<String>) {
    for (name, layer) in layers {
        if layer.roots.is_empty() {
            errs.push(format!("architecture.yaml {name}.roots empty."));
        }
        for target in &layer.may_import {
            if !layers.contains_key(target) {
                errs.push(format!("architecture.yaml {name} unknown {target}"));
            }
        }
    }
}

fn check_gateways(root: &Path, parsed: &GatewaysFile, errs: &mut Vec<String>) {
    for (name, entry) in &parsed.approved_gateways {
        let key = format!("gateways.yaml approvedGateways.{name}");
        check_path(root, &entry.wrapper, &key, errs);
        if entry.banned_direct_imports.is_empty() {
            errs.push(format!("{key}.bannedDirectImports is empty."));
        }
    }
}

fn decode_yaml_registry<T: serde::de::DeserializeOwned>(
    path: &Path,
    key: &str,
) -> Result<T, KernelError> {
    let text = fs::read_to_string(path).map_err(|e| io_err("read", path, e))?;
    yaml_serde::from_str(&text).map_err(|source| KernelError::YamlDecode {
        key: key.to_owned(),
        path: path.to_path_buf(),
        source,
    })
}
