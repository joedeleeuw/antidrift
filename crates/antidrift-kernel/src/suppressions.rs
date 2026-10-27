use crate::diagnostic::RuleDiagnostic;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuppressionCount {
    pub count: usize,
}

pub type FileRuleSuppressions = BTreeMap<String, SuppressionCount>;
pub type SuppressionsMap = BTreeMap<String, FileRuleSuppressions>;

#[derive(Debug, Clone, Default)]
pub struct SuppressionsTable {
    entries: SuppressionsMap,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuppressionVerdict {
    pub unsuppressed_diagnostics: BTreeMap<String, Vec<RuleDiagnostic>>,
    pub unused_suppressions: Vec<(String, String, usize, usize)>,
}

impl SuppressionsTable {
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(path)
            .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
        let entries: SuppressionsMap = serde_json::from_str(&raw)
            .map_err(|err| format!("failed to parse {}: {err}", path.display()))?;
        Ok(Self { entries })
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let mut serialized = serde_json::to_string_pretty(&self.entries)
            .map_err(|err| format!("failed to serialize suppressions: {err}"))?;
        serialized.push('\n');
        fs::write(path, serialized)
            .map_err(|err| format!("failed to write {}: {err}", path.display()))
    }

    #[must_use]
    pub fn evaluate(
        &self,
        diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
    ) -> SuppressionVerdict {
        let mut unsuppressed_diagnostics: BTreeMap<String, Vec<RuleDiagnostic>> = BTreeMap::new();
        let mut observed_counts: BTreeMap<(String, String), usize> = BTreeMap::new();

        for (file_path, diagnostics) in diagnostics_by_file {
            self.evaluate_file_diagnostics(
                file_path,
                diagnostics,
                &mut observed_counts,
                &mut unsuppressed_diagnostics,
            );
        }

        let unused_suppressions = self.collect_unused_suppressions(&observed_counts);
        SuppressionVerdict {
            unsuppressed_diagnostics,
            unused_suppressions,
        }
    }

    fn evaluate_file_diagnostics(
        &self,
        file_path: &str,
        diagnostics: &[RuleDiagnostic],
        observed_counts: &mut BTreeMap<(String, String), usize>,
        unsuppressed_diagnostics: &mut BTreeMap<String, Vec<RuleDiagnostic>>,
    ) {
        let mut by_rule: BTreeMap<&str, Vec<&RuleDiagnostic>> = BTreeMap::new();
        for diag in diagnostics {
            by_rule.entry(diag.rule_id.as_str()).or_default().push(diag);
        }
        for (rule_id, rule_diags) in by_rule {
            let actual = rule_diags.len();
            observed_counts.insert((file_path.to_string(), rule_id.to_string()), actual);
            let suppressed = self.suppressed_count(file_path, rule_id);
            if actual > suppressed {
                unsuppressed_diagnostics
                    .entry(file_path.to_string())
                    .or_default()
                    .extend(rule_diags.into_iter().cloned());
            }
        }
    }

    fn collect_unused_suppressions(
        &self,
        observed_counts: &BTreeMap<(String, String), usize>,
    ) -> Vec<(String, String, usize, usize)> {
        let mut unused = Vec::new();
        for (file_path, rules) in &self.entries {
            append_unused_for_file(file_path, rules, observed_counts, &mut unused);
        }
        unused
    }

    fn suppressed_count(&self, file_path: &str, rule_id: &str) -> usize {
        self.entries
            .get(file_path)
            .and_then(|rules| rules.get(rule_id))
            .map_or(0, |entry| entry.count)
    }

    pub fn prune(&mut self, diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>) {
        let mut pruned: SuppressionsMap = BTreeMap::new();
        for (file_path, rules) in &self.entries {
            let file_diags = diagnostics_by_file
                .get(file_path)
                .map_or(&[][..], Vec::as_slice);
            let updated_rules = prune_file_rules(rules, file_diags);
            if !updated_rules.is_empty() {
                pruned.insert(file_path.clone(), updated_rules);
            }
        }
        self.entries = pruned;
    }

    pub fn suppress_rules(
        &mut self,
        diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
        target_rules: &[String],
    ) {
        for (file_path, diagnostics) in diagnostics_by_file {
            self.suppress_file_rules(file_path, diagnostics, target_rules);
        }
    }

    fn suppress_file_rules(
        &mut self,
        file_path: &str,
        diagnostics: &[RuleDiagnostic],
        target_rules: &[String],
    ) {
        for rule_id in target_rules {
            let count = count_rule_diagnostics(diagnostics, rule_id);
            if count > 0 {
                self.entries
                    .entry(file_path.to_string())
                    .or_default()
                    .insert(rule_id.clone(), SuppressionCount { count });
            }
        }
    }
}

fn append_unused_for_file(
    file_path: &str,
    rules: &FileRuleSuppressions,
    observed_counts: &BTreeMap<(String, String), usize>,
    unused: &mut Vec<(String, String, usize, usize)>,
) {
    for (rule_id, entry) in rules {
        let actual = observed_counts
            .get(&(file_path.to_string(), rule_id.clone()))
            .copied()
            .unwrap_or(0);
        if actual < entry.count {
            unused.push((file_path.to_string(), rule_id.clone(), entry.count, actual));
        }
    }
}

fn prune_file_rules(
    rules: &FileRuleSuppressions,
    file_diags: &[RuleDiagnostic],
) -> FileRuleSuppressions {
    let mut updated_rules = FileRuleSuppressions::new();
    for (rule_id, entry) in rules {
        let actual = count_rule_diagnostics(file_diags, rule_id);
        let next_count = actual.min(entry.count);
        if next_count > 0 {
            updated_rules.insert(rule_id.clone(), SuppressionCount { count: next_count });
        }
    }
    updated_rules
}

fn count_rule_diagnostics(diagnostics: &[RuleDiagnostic], rule_id: &str) -> usize {
    diagnostics
        .iter()
        .filter(|diag| diag.rule_id == rule_id)
        .count()
}
