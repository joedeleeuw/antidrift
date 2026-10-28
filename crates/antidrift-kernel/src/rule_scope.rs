use crate::rule::RuleContext;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tsrs_core::tspath;

pub fn decode_rule_options<T: DeserializeOwned + Default>(
    rule_name: &str,
    options: Option<&Value>,
) -> Result<T, String> {
    let Some(raw) = options else {
        return Ok(T::default());
    };
    if raw.is_null() {
        return Ok(T::default());
    }
    let target = match raw.as_array() {
        Some(arr) => {
            let Some(first) = arr.first() else {
                return Ok(T::default());
            };
            if first.is_null() {
                return Ok(T::default());
            }
            first
        }
        None => raw,
    };
    serde_json::from_value::<T>(target.clone())
        .map_err(|err| format!("invalid options for {rule_name}: {err}"))
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ScopeOptions {
    pub files: Option<Vec<String>>,
    pub exclude_files: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RuleScope {
    files: Option<GlobSet>,
    exclude_files: Option<GlobSet>,
}

impl RuleScope {
    pub const DEFAULT: Self = Self {
        files: None,
        exclude_files: None,
    };

    pub fn from_options(rule_name: &str, options: Option<&Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<ScopeOptions>(rule_name, options)?;
        Self::from_scope_options(rule_name, &parsed)
    }

    pub fn from_scope_options(rule_name: &str, parsed: &ScopeOptions) -> Result<Self, String> {
        let files = match &parsed.files {
            Some(patterns) => Some(compile_glob_set(rule_name, "files", patterns)?),
            None => None,
        };
        let exclude_files = if parsed.exclude_files.is_empty() {
            None
        } else {
            Some(compile_glob_set(
                rule_name,
                "excludeFiles",
                &parsed.exclude_files,
            )?)
        };
        Ok(Self {
            files,
            exclude_files,
        })
    }

    #[must_use]
    pub const fn has_explicit_files(&self) -> bool {
        self.files.is_some()
    }

    #[must_use]
    pub fn matches(&self, file_name: &str, cwd: &str) -> bool {
        let normalized = tspath::normalize_slashes(file_name);
        let local = crate::provenance::relative_to_cwd(cwd, &normalized);
        let included = match &self.files {
            Some(set) => set.is_match(&local) || set.is_match(&normalized),
            None => true,
        };
        let excluded = self
            .exclude_files
            .as_ref()
            .is_some_and(|set| set.is_match(&local) || set.is_match(&normalized));
        included && !excluded
    }
}

fn compile_glob_set(rule_name: &str, field: &str, patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|err| format!("invalid glob '{pattern}' in {field} for {rule_name}: {err}"))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|err| format!("failed to compile {field} globs for {rule_name}: {err}"))
}

#[must_use]
pub fn is_rule_file(ctx: &RuleContext<'_, '_>, inferred_scope: Option<fn(&str) -> bool>) -> bool {
    let Ok(scope) = RuleScope::from_options("antidrift", Some(ctx.options)) else {
        return false;
    };
    let filename = ctx.file_path.replace('\\', "/");
    let matches_inferred = if scope.has_explicit_files() {
        true
    } else {
        inferred_scope.is_none_or(|predicate| predicate(&filename))
    };
    scope.matches(&filename, "") && matches_inferred
}
