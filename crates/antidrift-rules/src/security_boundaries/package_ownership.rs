use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Default)]
pub(super) struct PackageManifest {
    pub(super) name: Option<String>,
    pub(super) dependencies: Option<BTreeMap<String, String>>,
    pub(super) dev_dependencies: Option<BTreeMap<String, String>>,
    pub(super) peer_dependencies: Option<BTreeMap<String, String>>,
    pub(super) optional_dependencies: Option<BTreeMap<String, String>>,
    workspaces: Option<IgnoredAny>,
    pub(super) format: Option<PackageFormat>,
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum PackageField {
    Name,
    Dependencies,
    DevDependencies,
    PeerDependencies,
    OptionalDependencies,
    Workspaces,
    #[serde(rename = "type")]
    Format,
    #[serde(other)]
    Other,
}

impl<'de> Deserialize<'de> for PackageManifest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(ManifestVisitor)
    }
}

struct ManifestVisitor;

impl<'de> Visitor<'de> for ManifestVisitor {
    type Value = PackageManifest;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a package.json object with typed dependency fields")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut fields: M) -> Result<PackageManifest, M::Error> {
        let mut manifest = PackageManifest::default();
        while let Some(field) = fields.next_key::<PackageField>()? {
            match field {
                PackageField::Name => manifest.name = fields.next_value()?,
                PackageField::Dependencies => manifest.dependencies = fields.next_value()?,
                PackageField::DevDependencies => manifest.dev_dependencies = fields.next_value()?,
                PackageField::PeerDependencies => {
                    manifest.peer_dependencies = fields.next_value()?;
                }
                PackageField::OptionalDependencies => {
                    manifest.optional_dependencies = fields.next_value()?;
                }
                PackageField::Workspaces => manifest.workspaces = fields.next_value()?,
                PackageField::Format => manifest.format = fields.next_value()?,
                PackageField::Other => {
                    fields.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(manifest)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum PackageFormat {
    Module,
    Commonjs,
}

pub(super) struct PackageOwner {
    pub(super) directory: PathBuf,
    pub(super) manifest: PackageManifest,
}

pub(super) fn absolute_filename(filename: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(filename)
        .map_err(|error| format!("Cannot resolve filename '{}': {error}", filename.display()))?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

pub(super) fn package_owner(filename: &Path) -> Result<Option<PackageOwner>, String> {
    let absolute = absolute_filename(filename)?;
    let mut cursor = absolute.parent();
    while let Some(directory) = cursor {
        let manifest_path = directory.join("package.json");
        if manifest_path.try_exists().map_err(|error| {
            format!(
                "Cannot inspect package manifest '{}': {error}",
                manifest_path.display()
            )
        })? {
            let source = std::fs::read_to_string(&manifest_path).map_err(|error| {
                format!(
                    "Cannot read package manifest '{}': {error}",
                    manifest_path.display()
                )
            })?;
            let manifest: PackageManifest = serde_json::from_str(&source).map_err(|error| {
                format!(
                    "Invalid package manifest '{}': {error}",
                    manifest_path.display()
                )
            })?;
            if owns_package(&manifest) {
                return Ok(Some(PackageOwner {
                    directory: directory.to_path_buf(),
                    manifest,
                }));
            }
        }
        cursor = directory.parent();
    }
    Ok(None)
}

fn owns_package(manifest: &PackageManifest) -> bool {
    manifest.name.is_some()
        || manifest.dependencies.is_some()
        || manifest.dev_dependencies.is_some()
        || manifest.peer_dependencies.is_some()
        || manifest.optional_dependencies.is_some()
        || manifest.workspaces.is_some()
}
