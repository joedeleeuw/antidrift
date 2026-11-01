use super::catalog::{RULES, ResolvedRule, row};
use crate::rule_scope::{RuleScope, ScopeOptions};
use antidrift_kernel::diagnostic::Severity;
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", default)]
pub(super) struct AntidriftTable {
    rules: BTreeMap<String, RuleSetting>,
    layers: LayerTable,
    forbidden_calls: Vec<ForbiddenCall>,
    module_macros: Vec<String>,
}

enum RuleSetting {
    Level(Severity),
    Scoped(ScopedSetting),
}

const VALID_LEVELS: &str = "off, warn, error";

fn parse_level(text: &str) -> Result<Severity, String> {
    match text {
        "off" => Ok(Severity::Off),
        "warn" => Ok(Severity::Warn),
        "error" => Ok(Severity::Error),
        other => Err(format!(
            "unknown level '{other}'; valid levels: {VALID_LEVELS}"
        )),
    }
}

impl<'de> Deserialize<'de> for RuleSetting {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SettingVisitor;

        impl<'de> Visitor<'de> for SettingVisitor {
            type Value = RuleSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(
                    formatter,
                    "a level ({VALID_LEVELS}) or a table with level, files and exclude-files"
                )
            }

            fn visit_str<E: de::Error>(self, text: &str) -> Result<Self::Value, E> {
                parse_level(text).map(RuleSetting::Level).map_err(E::custom)
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                ScopedSetting::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(RuleSetting::Scoped)
            }
        }

        deserializer.deserialize_any(SettingVisitor)
    }
}

fn deserialize_scoped_level<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Severity, D::Error> {
    let text = String::deserialize(deserializer)?;
    parse_level(&text).map_err(|error| de::Error::custom(format!("level: {error}")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
struct ScopedSetting {
    #[serde(deserialize_with = "deserialize_scoped_level")]
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
    pub(super) manifest_path: PathBuf,
    pub(super) root_dir: PathBuf,
    pub(super) workspace_defines_lints: bool,
    pub(super) levels: BTreeMap<&'static str, RuleLevel>,
    pub(super) layers: LayerTable,
    pub(super) forbidden_calls: Vec<ForbiddenCall>,
    pub(super) module_macros: Vec<String>,
}

pub(super) struct ConfigSource<'a> {
    pub(super) manifest_path: &'a Path,
    pub(super) table_name: &'static str,
    pub(super) table: Option<&'a AntidriftTable>,
    pub(super) workspace_defines_lints: bool,
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

    pub(super) fn defaults(root_dir: &Path) -> Self {
        Self {
            manifest_path: PathBuf::new(),
            root_dir: root_dir.to_path_buf(),
            workspace_defines_lints: false,
            levels: default_levels(),
            layers: LayerTable::default(),
            forbidden_calls: Vec::new(),
            module_macros: Vec::new(),
        }
    }

    pub(super) fn from_source(source: &ConfigSource<'_>) -> Result<Self, String> {
        let manifest_path = source.manifest_path;
        let root_dir = manifest_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let mut config = Self {
            manifest_path: manifest_path.to_path_buf(),
            root_dir,
            workspace_defines_lints: source.workspace_defines_lints,
            levels: default_levels(),
            layers: LayerTable::default(),
            forbidden_calls: Vec::new(),
            module_macros: Vec::new(),
        };
        let Some(table) = source.table else {
            return Ok(config);
        };
        let table_name = source.table_name;
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
            config.levels.insert(known.id, resolved);
        }
        config.layers = LayerTable {
            crates: table.layers.crates.clone(),
            modules: table.layers.modules.clone(),
        };
        config.forbidden_calls.clone_from(&table.forbidden_calls);
        config.module_macros.clone_from(&table.module_macros);
        Ok(config)
    }
}

fn default_levels() -> BTreeMap<&'static str, RuleLevel> {
    RULES
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
        .collect()
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
            let scope = RuleScope::from_scope_options(rule_id, &options)?;
            Ok(RuleLevel {
                level: scoped.level,
                scope,
            })
        }
    }
}
