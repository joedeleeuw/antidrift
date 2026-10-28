use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tsrs_ast::Node;
use tsrs_core::{P, tspath};
use tsrslint::rule::{Ctx, Listener, RuleVisitor};

pub struct EmptyVisitor;

impl RuleVisitor for EmptyVisitor {
    fn listeners(&self) -> &[Listener] {
        &[]
    }

    fn visit(&mut self, _ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {}
}

pub trait ScopedOptions: DeserializeOwned + Default {
    fn scope(&self) -> ScopeOptions;

    fn validate(&self, _rule_name: &str) -> Result<(), String> {
        Ok(())
    }
}

pub fn decode_scoped<T: ScopedOptions>(
    rule_name: &str,
    raw: Option<&Value>,
) -> Result<(T, RuleScope), String> {
    let options = decode_rule_options::<T>(rule_name, raw)?;
    options.validate(rule_name)?;
    let scope = RuleScope::from_scope_options(rule_name, &options.scope())?;
    Ok((options, scope))
}

pub fn require_non_empty(
    rule_name: &str,
    field: &str,
    text: Option<&String>,
) -> Result<(), String> {
    if text.is_some_and(String::is_empty) {
        return Err(format!(
            "invalid options for {rule_name}: '{field}' must be a non-empty string"
        ));
    }
    Ok(())
}

#[must_use]
pub fn in_scope(scope: &RuleScope, ctx: &Ctx, inferred_scope: Option<fn(&str) -> bool>) -> bool {
    let filename = tspath::normalize_slashes(ctx.file.file_name());
    let matches_inferred = if scope.has_explicit_files() {
        true
    } else {
        inferred_scope.is_none_or(|predicate| predicate(&filename))
    };
    scope.in_scope(ctx) && matches_inferred
}

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
    pub fn in_scope(&self, ctx: &Ctx) -> bool {
        let filename = tspath::normalize_slashes(ctx.file.file_name());
        let cwd = ctx.program.host().get_current_directory();
        self.matches(&filename, cwd)
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
