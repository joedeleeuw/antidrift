use super::cargo_manifest::{CargoManifest, read_manifest};
use super::catalog::{RULES, ResolvedRule, row};
use antidrift_kernel::diagnostic::Severity;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", default)]
pub(super) struct AntidriftTable {
    rules: BTreeMap<String, RuleSetting>,
    layers: LayerTable,
    forbidden_calls: Vec<ForbiddenCall>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RuleSetting {
    Level(Severity),
    Scoped(ScopedSetting),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
struct ScopedSetting {
    level: Severity,
    #[serde(default)]
    files: Option<Vec<String>>,
    #[serde(default)]
    exclude_files: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", default)]
pub(super) struct LayerTable {
    pub(super) crates: Vec<String>,
    pub(super) modules: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(super) struct ForbiddenCall {
    pub(super) callee: String,
    #[serde(default)]
    pub(super) argument: Option<String>,
    pub(super) reason: String,
}

pub(super) struct RuleLevel {
    pub(super) level: Severity,
    pub(super) scope: RuleScope,
}

pub(super) struct RustConfig {
    pub(super) levels: BTreeMap<&'static str, RuleLevel>,
    pub(super) layers: LayerTable,
    pub(super) forbidden_calls: Vec<ForbiddenCall>,
}

impl RustConfig {
    pub(super) fn level_of(&self, rule_id: &str) -> Option<&RuleLevel> {
        self.levels.get(rule_id)
    }

    pub(super) fn resolved_rules(&self) -> Vec<ResolvedRule> {
        RULES
            .iter()
            .map(|row| {
                let level = self
                    .levels
                    .get(row.id)
                    .map_or_else(|| row.default_level(), |setting| setting.level);
                ResolvedRule::new(row, level)
            })
            .collect()
    }

    pub(super) fn load(start_dir: &Path) -> Result<Self, String> {
        let mut package_manifest = None;
        for directory in start_dir.ancestors() {
            let manifest_path = directory.join("Cargo.toml");
            if !manifest_path.is_file() {
                continue;
            }
            let manifest = read_manifest(&manifest_path)?;
            if let Some(workspace) = &manifest.workspace {
                return Self::from_table(
                    &manifest_path,
                    "[workspace.metadata.antidrift]",
                    workspace.metadata.antidrift.as_ref(),
                );
            }
            if package_manifest.is_none() && manifest.package.is_some() {
                package_manifest = Some((manifest_path, manifest));
            }
        }
        match package_manifest {
            Some((manifest_path, manifest)) => Self::from_table(
                &manifest_path,
                "[package.metadata.antidrift]",
                package_table(&manifest),
            ),
            None => Self::from_table(Path::new(""), "", None),
        }
    }

    fn from_table(
        manifest_path: &Path,
        table_name: &str,
        table: Option<&AntidriftTable>,
    ) -> Result<Self, String> {
        let mut levels: BTreeMap<&'static str, RuleLevel> = RULES
            .iter()
            .map(|row| {
                (
                    row.id,
                    RuleLevel {
                        level: row.default_level(),
                        scope: RuleScope::DEFAULT,
                    },
                )
            })
            .collect();
        let Some(table) = table else {
            return Ok(Self {
                levels,
                layers: LayerTable::default(),
                forbidden_calls: Vec::new(),
            });
        };
        for (rule_id, setting) in &table.rules {
            let Some(known) = row(rule_id) else {
                return Err(format!(
                    "{}: {table_name} rules names unknown rule '{rule_id}'; known rules: {}",
                    manifest_path.display(),
                    RULES
                        .iter()
                        .map(|row| row.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            };
            let resolved = resolve_setting(known.id, setting).map_err(|error| {
                format!(
                    "{}: {table_name} rules.\"{rule_id}\": {error}",
                    manifest_path.display()
                )
            })?;
            levels.insert(known.id, resolved);
        }
        Ok(Self {
            levels,
            layers: LayerTable {
                crates: table.layers.crates.clone(),
                modules: table.layers.modules.clone(),
            },
            forbidden_calls: table.forbidden_calls.clone(),
        })
    }
}

fn resolve_setting(rule_id: &'static str, setting: &RuleSetting) -> Result<RuleLevel, String> {
    match setting {
        RuleSetting::Level(level) => Ok(RuleLevel {
            level: *level,
            scope: RuleScope::DEFAULT,
        }),
        RuleSetting::Scoped(scoped) => {
            let options = ScopeOptions {
                files: scoped.files.clone(),
                exclude_files: scoped.exclude_files.clone(),
            };
            let scope = RuleScope::from_scope_options(rule_id, &options)
                .map_err(|error| error.to_string())?;
            Ok(RuleLevel {
                level: scoped.level,
                scope,
            })
        }
    }
}

fn package_table(manifest: &CargoManifest) -> Option<&AntidriftTable> {
    manifest.package.as_ref()?.metadata.antidrift.as_ref()
}
