use crate::rule::RuleContext;
use globset::GlobBuilder;
use serde_json::Value;

#[must_use]
pub fn is_rule_file(ctx: &RuleContext<'_, '_>, inferred_scope: Option<fn(&str) -> bool>) -> bool {
    let filename = ctx.file_path.replace('\\', "/");
    let first_option = match ctx.options {
        Value::Array(items) => items.first().unwrap_or(&Value::Null),
        other => other,
    };
    let files = extract_glob_list(first_option, "files");
    let exclude_files = extract_glob_list(first_option, "excludeFiles").unwrap_or_default();

    let matches_files = match &files {
        Some(patterns) => patterns
            .iter()
            .any(|pattern| glob_matches(&filename, pattern)),
        None => true,
    };
    let matches_inferred = if files.is_some() {
        true
    } else {
        inferred_scope.is_none_or(|predicate| predicate(&filename))
    };
    let excluded = exclude_files
        .iter()
        .any(|pattern| glob_matches(&filename, pattern));

    matches_files && matches_inferred && !excluded
}

fn extract_glob_list(option_obj: &Value, field: &str) -> Option<Vec<String>> {
    let obj = option_obj.as_object()?;
    let arr = obj.get(field)?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect(),
    )
}

#[must_use]
pub fn glob_matches(path: &str, pattern: &str) -> bool {
    let Ok(glob) = GlobBuilder::new(pattern).literal_separator(true).build() else {
        return false;
    };
    let matcher = glob.compile_matcher();
    matcher.is_match(path)
}
