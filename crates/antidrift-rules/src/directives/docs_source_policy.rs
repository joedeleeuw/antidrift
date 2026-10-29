use antidrift_kernel::json_manifest::load_nearest_package_json_manifest;
use antidrift_kernel::rule_scope::{RuleScope, ScopeOptions, decode_rule_options};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/docs-source-policy";
const MAX_QUARANTINE_MS: i64 = 31 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct DocsSourcePolicyOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    policy_file: Option<String>,
    dependencies: Option<Vec<String>>,
    sources: BTreeMap<String, DocSourceEntry>,
    exclusions: Vec<DocExclusionEntry>,
    now: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct DocSourceEntry {
    url: String,
    dependencies: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct DocExclusionEntry {
    dependency: String,
    explanation: String,
    checked_at: String,
    expires_at: String,
}

pub struct DocsSourcePolicy {
    scope: RuleScope,
    options: Option<DocsSourcePolicyOptions>,
}

pub static DEFAULT_RULE: DocsSourcePolicy = DocsSourcePolicy {
    scope: RuleScope::DEFAULT,
    options: None,
};

impl DocsSourcePolicy {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = decode_rule_options::<DocsSourcePolicyOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &parsed.scope)?;
        Ok(Self {
            scope,
            options: Some(parsed),
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for DocsSourcePolicy {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let normalized_path = ctx.file.file_name().replace('\\', "/");
        let policy_file = self
            .options
            .as_ref()
            .and_then(|opts| opts.policy_file.as_deref())
            .unwrap_or("docs-sources.mjs");
        let matches_policy =
            normalized_path == policy_file || normalized_path.ends_with(&format!("/{policy_file}"));
        let enabled = self.scope.matches(&normalized_path, cwd) && matches_policy;
        Box::new(Visitor {
            enabled,
            rule: self,
        })
    }
}

struct Visitor {
    enabled: bool,
    rule: &'static DocsSourcePolicy,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        let default_opts = DocsSourcePolicyOptions::default();
        let opts = self.rule.options.as_ref().unwrap_or(&default_opts);
        let file_name = ctx.file.file_name().to_owned();
        let dependencies: BTreeSet<String> = match &opts.dependencies {
            Some(list) => list.iter().cloned().collect(),
            None => load_nearest_package_dependencies(&file_name),
        };
        let now_ms = opts
            .now
            .as_deref()
            .and_then(parse_iso_utc_millis)
            .unwrap_or(0);
        let failures = evaluate_policy(&dependencies, &opts.sources, &opts.exclusions, now_ms);
        let end = i32::try_from(ctx.file.text().len()).unwrap_or(0);
        for failure in failures {
            ctx.report_range(
                0,
                end,
                RuleMessage::new(
                    "policyFailure",
                    format!("Documentation registry owner: {failure}"),
                ),
            );
        }
    }
}

fn load_nearest_package_dependencies(file_path: &str) -> BTreeSet<String> {
    load_nearest_package_json_manifest(Path::new(file_path))
        .and_then(|manifest| {
            manifest
                .sections
                .get("dependencies")
                .map(|entries| entries.iter().map(|entry| entry.key.clone()).collect())
        })
        .unwrap_or_default()
}

fn evaluate_policy(
    dependencies: &BTreeSet<String>,
    sources: &BTreeMap<String, DocSourceEntry>,
    exclusions: &[DocExclusionEntry],
    now_ms: i64,
) -> Vec<String> {
    let mut failures = Vec::new();
    let mut classifications: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (source_name, source) in sources {
        if source.dependencies.is_empty() {
            failures.push(format!("{source_name} has no covered dependencies."));
        }
        check_source_url(source_name, &source.url, &mut failures);
        for dep in &source.dependencies {
            classifications
                .entry(dep.clone())
                .or_default()
                .push(format!("source {source_name}"));
        }
    }

    for exclusion in exclusions {
        classifications
            .entry(exclusion.dependency.clone())
            .or_default()
            .push("exclusion".to_owned());
        check_exclusion(exclusion, now_ms, &mut failures);
    }

    for dep in dependencies {
        if !classifications.contains_key(dep) {
            failures.push(format!(
                "{dep} is a direct dependency without an llms.txt source or explained exclusion."
            ));
        }
    }

    for (dep, dispositions) in &classifications {
        if !dependencies.contains(dep) {
            failures.push(format!(
                "{dep} is classified by {} but is not a direct dependency.",
                dispositions.join(" and ")
            ));
        }
        if dispositions.len() > 1 {
            failures.push(format!(
                "{dep} is classified by {}.",
                dispositions.join(" and ")
            ));
        }
    }

    failures.sort();
    failures
}

fn check_source_url(source_name: &str, url: &str, failures: &mut Vec<String>) {
    let Some((scheme, rest)) = url.split_once("://") else {
        failures.push(format!("{source_name} has an invalid llms.txt URL."));
        return;
    };
    let host_and_path = rest.split(['?', '#']).next().unwrap_or(rest);
    let Some((host, path_part)) = host_and_path.split_once('/') else {
        if scheme != "https" {
            failures.push(format!(
                "{source_name} must use an HTTPS URL ending in /llms.txt."
            ));
        } else {
            failures.push(format!("{source_name} has an invalid llms.txt URL."));
        }
        return;
    };
    if host.is_empty() {
        failures.push(format!("{source_name} has an invalid llms.txt URL."));
        return;
    }
    let full_path = format!("/{path_part}");
    if scheme != "https" || !full_path.ends_with("/llms.txt") {
        failures.push(format!(
            "{source_name} must use an HTTPS URL ending in /llms.txt."
        ));
    }
}

fn check_exclusion(exclusion: &DocExclusionEntry, now_ms: i64, failures: &mut Vec<String>) {
    if exclusion.explanation.trim().is_empty() {
        failures.push(format!(
            "{} has no exclusion explanation.",
            exclusion.dependency
        ));
    }
    let Some(checked_at) = parse_iso_utc_millis(&exclusion.checked_at) else {
        failures.push(format!(
            "{} has an invalid no-llms-txt checkedAt timestamp.",
            exclusion.dependency
        ));
        return;
    };
    let Some(expires_at) = parse_iso_utc_millis(&exclusion.expires_at) else {
        failures.push(format!(
            "{} has an invalid no-llms-txt expiresAt timestamp.",
            exclusion.dependency
        ));
        return;
    };
    if expires_at <= checked_at {
        failures.push(format!(
            "{} has a no-llms-txt quarantine that does not follow its check time.",
            exclusion.dependency
        ));
    }
    if expires_at - checked_at > MAX_QUARANTINE_MS {
        failures.push(format!(
            "{} has a no-llms-txt quarantine longer than 31 days.",
            exclusion.dependency
        ));
    }
    if now_ms >= expires_at {
        failures.push(format!(
            "{} has an expired no-llms-txt quarantine ({}); recheck its canonical documentation.",
            exclusion.dependency, exclusion.expires_at
        ));
    }
}

fn parse_iso_utc_millis(value: &str) -> Option<i64> {
    if value.len() != 24 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let year = parse_ascii_digits(&value[0..4])?;
    let month = parse_ascii_digits(&value[5..7])?;
    let day = parse_ascii_digits(&value[8..10])?;
    let hour = parse_ascii_digits(&value[11..13])?;
    let minute = parse_ascii_digits(&value[14..16])?;
    let second = parse_ascii_digits(&value[17..19])?;
    let millis = parse_ascii_digits(&value[20..23])?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let total_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(total_seconds * 1_000 + millis)
}

fn parse_ascii_digits(slice: &str) -> Option<i64> {
    let mut acc = 0_i64;
    for byte in slice.bytes() {
        if !byte.is_ascii_digit() {
            return None;
        }
        acc = acc * 10 + i64::from(byte - b'0');
    }
    Some(acc)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let yoe = adjusted_year - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
