use super::cargo_manifest::{ManifestSource, read_manifest_source};
use super::config::{ConfigSource, RustConfig};
use super::module_graph::normalize_lexical_path;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use rustc_hash::FxHashMap;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[derive(Default)]
pub(super) struct ConfigResolver {
    manifests: FxHashMap<PathBuf, Rc<ManifestSource>>,
    configs: FxHashMap<PathBuf, Rc<RustConfig>>,
    owners: FxHashMap<PathBuf, PathBuf>,
    members: FxHashMap<PathBuf, Rc<WorkspaceMembers>>,
}

struct WorkspaceMembers {
    dirs: BTreeSet<PathBuf>,
    excluded: Vec<PathBuf>,
}

impl WorkspaceMembers {
    fn excludes(&self, package_dir: &Path) -> bool {
        self.excluded
            .iter()
            .any(|excluded| package_dir.starts_with(excluded))
    }
}

pub(super) fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|err| {
        format!(
            "cannot resolve {} against the current directory: {err}",
            path.display()
        )
    })?;
    Ok(normalize_lexical_path(&absolute))
}

pub(super) fn discover_crate_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();
    collect_crate_dirs_recursive(root, &mut dirs)?;
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}

fn collect_crate_dirs_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if dir.join("Cargo.toml").is_file() {
        out.push(dir.to_path_buf());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|err| format!("failed to read directory entry: {err}"))?
            .path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if matches!(
            name,
            ".git"
                | "target"
                | "node_modules"
                | "src"
                | "tests"
                | "benches"
                | "examples"
                | "vendor"
                | "dist"
        ) || name.starts_with('.')
        {
            continue;
        }
        collect_crate_dirs_recursive(&path, out)?;
    }
    Ok(())
}

fn compile_member_globs(workspace_manifest: &Path, patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern.trim_end_matches('/'))
            .literal_separator(true)
            .build()
            .map_err(|err| {
                format!(
                    "{}: [workspace] members pattern '{pattern}' is not a valid glob: {err}",
                    workspace_manifest.display()
                )
            })?;
        builder.add(glob);
    }
    builder.build().map_err(|err| {
        format!(
            "{}: [workspace] members globs failed to compile: {err}",
            workspace_manifest.display()
        )
    })
}

impl ConfigResolver {
    fn manifest(&mut self, manifest_path: &Path) -> Result<Rc<ManifestSource>, String> {
        if let Some(cached) = self.manifests.get(manifest_path) {
            return Ok(Rc::clone(cached));
        }
        let source = Rc::new(read_manifest_source(manifest_path)?);
        self.manifests
            .insert(manifest_path.to_path_buf(), Rc::clone(&source));
        Ok(source)
    }

    fn workspace_members(
        &mut self,
        workspace_manifest: &Path,
    ) -> Result<Rc<WorkspaceMembers>, String> {
        if let Some(cached) = self.members.get(workspace_manifest) {
            return Ok(Rc::clone(cached));
        }
        let root = self.manifest(workspace_manifest)?;
        let workspace_dir = root.directory().to_path_buf();
        let Some(table) = &root.manifest.workspace else {
            return Err(format!(
                "engine bug: {} is not a workspace manifest",
                workspace_manifest.display()
            ));
        };
        let excluded: Vec<PathBuf> = table
            .exclude
            .iter()
            .map(|entry| normalize_lexical_path(&workspace_dir.join(entry)))
            .collect();
        let globs = compile_member_globs(workspace_manifest, &table.members)?;
        let mut dirs = BTreeSet::new();
        if root.manifest.package.is_some() {
            dirs.insert(workspace_dir.clone());
        }
        for pattern in &table.members {
            let member_dir = normalize_lexical_path(&workspace_dir.join(pattern));
            if member_dir.join("Cargo.toml").is_file()
                && !excluded.iter().any(|ex| member_dir.starts_with(ex))
            {
                dirs.insert(member_dir);
            }
        }
        for candidate in discover_crate_dirs(&workspace_dir)? {
            let Ok(relative) = candidate.strip_prefix(&workspace_dir) else {
                continue;
            };
            if globs.is_match(relative) && !excluded.iter().any(|ex| candidate.starts_with(ex)) {
                dirs.insert(candidate);
            }
        }
        let workspace_deps = table.dependencies.clone();
        let initial_roots = root.dependency_paths(Some((&workspace_dir, &workspace_deps)));
        self.add_path_dependency_members(
            &workspace_dir,
            &workspace_deps,
            initial_roots,
            &excluded,
            &mut dirs,
        )?;
        let members = Rc::new(WorkspaceMembers { dirs, excluded });
        self.members
            .insert(workspace_manifest.to_path_buf(), Rc::clone(&members));
        Ok(members)
    }

    fn add_path_dependency_members(
        &mut self,
        workspace_dir: &Path,
        workspace_deps: &std::collections::BTreeMap<String, toml::Value>,
        initial_roots: Vec<PathBuf>,
        excluded: &[PathBuf],
        dirs: &mut BTreeSet<PathBuf>,
    ) -> Result<(), String> {
        let mut pending: Vec<PathBuf> = dirs.iter().cloned().collect();
        for dependency_dir in initial_roots {
            let normalized = normalize_lexical_path(&dependency_dir);
            if normalized.starts_with(workspace_dir)
                && !excluded.iter().any(|ex| normalized.starts_with(ex))
                && normalized.join("Cargo.toml").is_file()
                && dirs.insert(normalized.clone())
            {
                pending.push(normalized);
            }
        }
        while let Some(member_dir) = pending.pop() {
            let member = self.manifest(&member_dir.join("Cargo.toml"))?;
            pending.extend(
                member
                    .dependency_paths(Some((workspace_dir, workspace_deps)))
                    .into_iter()
                    .map(|dependency_dir| normalize_lexical_path(&dependency_dir))
                    .filter(|dependency_dir| {
                        dependency_dir.starts_with(workspace_dir)
                            && !excluded.iter().any(|ex| dependency_dir.starts_with(ex))
                            && dependency_dir.join("Cargo.toml").is_file()
                    })
                    .filter(|dependency_dir| dirs.insert(dependency_dir.clone())),
            );
        }
        Ok(())
    }

    fn owner_of_package(&mut self, package_dir: &Path) -> Result<PathBuf, String> {
        if let Some(owner) = self.owners.get(package_dir) {
            return Ok(owner.clone());
        }
        let own_manifest = package_dir.join("Cargo.toml");
        let manifest = self.manifest(&own_manifest)?;
        let owner = if manifest.manifest.workspace.is_some() {
            own_manifest.clone()
        } else if let Some(explicit) = manifest
            .manifest
            .package
            .as_ref()
            .and_then(|package| package.workspace.as_deref())
        {
            let target = normalize_lexical_path(&package_dir.join(explicit));
            if target.is_dir() {
                target.join("Cargo.toml")
            } else {
                target
            }
        } else {
            self.nearest_owning_workspace(package_dir)?
                .unwrap_or_else(|| own_manifest.clone())
        };
        self.owners.insert(package_dir.to_path_buf(), owner.clone());
        Ok(owner)
    }

    fn nearest_owning_workspace(&mut self, package_dir: &Path) -> Result<Option<PathBuf>, String> {
        for ancestor in package_dir.ancestors().skip(1) {
            let candidate = ancestor.join("Cargo.toml");
            if !candidate.is_file() {
                continue;
            }
            if self.manifest(&candidate)?.manifest.workspace.is_none() {
                continue;
            }
            let members = self.workspace_members(&candidate)?;
            if members.excludes(package_dir) || !members.dirs.contains(package_dir) {
                return Ok(None);
            }
            return Ok(Some(candidate));
        }
        Ok(None)
    }

    fn config_for_owner(&mut self, owner_manifest: &Path) -> Result<Rc<RustConfig>, String> {
        if let Some(cached) = self.configs.get(owner_manifest) {
            return Ok(Rc::clone(cached));
        }
        let owner = self.manifest(owner_manifest)?;
        let source = match (&owner.manifest.workspace, &owner.manifest.package) {
            (Some(workspace), _) => ConfigSource {
                manifest_path: owner_manifest,
                table_name: "[workspace.metadata.antidrift]",
                table: workspace.metadata.antidrift.as_ref(),
                workspace_defines_lints: workspace.lints.is_some(),
            },
            (None, Some(package)) => ConfigSource {
                manifest_path: owner_manifest,
                table_name: "[package.metadata.antidrift]",
                table: package.metadata.antidrift.as_ref(),
                workspace_defines_lints: false,
            },
            (None, None) => {
                return Err(format!(
                    "{}: manifest declares neither [workspace] nor [package]",
                    owner_manifest.display()
                ));
            }
        };
        let config = Rc::new(RustConfig::from_source(&source)?);
        self.configs
            .insert(owner_manifest.to_path_buf(), Rc::clone(&config));
        Ok(config)
    }

    pub(super) fn config_for_package(
        &mut self,
        package_dir: &Path,
    ) -> Result<Rc<RustConfig>, String> {
        let owner = self.owner_of_package(package_dir)?;
        self.config_for_owner(&owner)
    }

    pub(super) fn config_for_directory(
        &mut self,
        directory: &Path,
    ) -> Result<Rc<RustConfig>, String> {
        for ancestor in directory.ancestors() {
            let candidate = ancestor.join("Cargo.toml");
            if !candidate.is_file() {
                continue;
            }
            let manifest = self.manifest(&candidate)?;
            if manifest.manifest.workspace.is_some() {
                return self.config_for_owner(&candidate);
            }
            if manifest.manifest.package.is_some() {
                return self.config_for_package(ancestor);
            }
        }
        Ok(Rc::new(RustConfig::defaults(directory)))
    }
}
