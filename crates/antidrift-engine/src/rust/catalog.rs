use antidrift_kernel::diagnostic::Severity;
use antidrift_kernel::line_caps::CappedUnit;
use antidrift_kernel::scope_policy::ScopePolicy;
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RuleKind {
    General,
    HouseStyle,
}

pub(super) struct RuleRow {
    pub(super) id: &'static str,
    pub(super) kind: RuleKind,
    pub(super) scope_policy: ScopePolicy,
    pub(super) guidance: &'static str,
}

impl RuleRow {
    pub(super) const fn default_level(&self) -> Severity {
        match self.kind {
            RuleKind::General => Severity::Error,
            RuleKind::HouseStyle => Severity::Off,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LineCapSetting {
    pub(super) warn_above: usize,
    pub(super) max: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResolvedRule {
    pub(super) id: &'static str,
    pub(super) kind: RuleKind,
    pub(super) scope_policy: ScopePolicy,
    pub(super) level: Severity,
    pub(super) guidance: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) line_cap: Option<LineCapSetting>,
}

impl ResolvedRule {
    pub(super) fn new(row: &RuleRow, level: Severity) -> Self {
        let line_cap = CappedUnit::ALL
            .iter()
            .map(|unit| unit.cap())
            .find(|cap| cap.rule_id == row.id)
            .map(|cap| LineCapSetting {
                warn_above: cap.warn_above,
                max: cap.max,
            });
        Self {
            id: row.id,
            kind: row.kind,
            scope_policy: row.scope_policy,
            level,
            guidance: row.guidance,
            line_cap,
        }
    }
}

const fn general(id: &'static str, scope_policy: ScopePolicy, guidance: &'static str) -> RuleRow {
    RuleRow {
        id,
        kind: RuleKind::General,
        scope_policy,
        guidance,
    }
}

const fn house_style(id: &'static str, guidance: &'static str) -> RuleRow {
    RuleRow {
        id,
        kind: RuleKind::HouseStyle,
        scope_policy: ScopePolicy::Everywhere,
        guidance,
    }
}

pub(super) const RULES: &[RuleRow] = &[
    general(
        "rust/syntax-error",
        ScopePolicy::Everywhere,
        "Every Rust source file must parse.",
    ),
    general(
        "rust/max-module-lines",
        ScopePolicy::Everywhere,
        "Keep Rust modules at or below 500 non-blank lines (warn above 425); split along a domain seam before reaching the ceiling.",
    ),
    general(
        "rust/require-workspace-lints",
        ScopePolicy::Everywhere,
        "When the workspace declares [workspace.lints], every member crate inherits it with `[lints] workspace = true`.",
    ),
    general(
        "rust/no-orphan-module",
        ScopePolicy::Everywhere,
        "Every Rust source file under src must be reachable from a Cargo target root through `mod` declarations.",
    ),
    general(
        "rust/no-grab-bag-module",
        ScopePolicy::Everywhere,
        "Name modules after the domain concept they own instead of utils, helpers, common, or misc.",
    ),
    general(
        "rust/no-hollow-module",
        ScopePolicy::Everywhere,
        "Delete empty or stub-only Rust modules.",
    ),
    general(
        "rust/no-layer-violation",
        ScopePolicy::Everywhere,
        "Depend only on lower layers: layers.crates and layers.modules in the antidrift metadata order crates and modules from lowest to highest.",
    ),
    general(
        "rust/no-forbidden-call",
        ScopePolicy::Everywhere,
        "Do not call the callees that forbidden-calls in the antidrift metadata lists; each row carries the reason.",
    ),
    general(
        "rust/no-boolean-map",
        ScopePolicy::Everywhere,
        "Replace Map<K, bool> with Set<K> or a closed state enum.",
    ),
    general(
        "rust/require-strict-serde",
        ScopePolicy::Everywhere,
        "Put #[serde(deny_unknown_fields)] on structs deriving Deserialize so unknown keys fail loudly.",
    ),
    general(
        "rust/no-stringly-variant",
        ScopePolicy::Everywhere,
        "Use closed enums instead of String or str discriminant fields.",
    ),
    general(
        "rust/no-untyped-config-probe",
        ScopePolicy::Everywhere,
        "Decode configuration once at the boundary instead of probing serde_json::Value inward.",
    ),
    general(
        "rust/no-let-underscore-suppression",
        ScopePolicy::Everywhere,
        "Do not suppress unused bindings or struct fields with let _ = ... or leading underscores.",
    ),
    general(
        "rust/no-ident-to-string-compare",
        ScopePolicy::Everywhere,
        "Compare syn::Ident directly against string literals without allocating .to_string().",
    ),
    general(
        "rust/no-compat-names",
        ScopePolicy::Everywhere,
        "Delete legacy, compat, or batch-scaffolding names instead of preserving them.",
    ),
    general(
        "rust/no-wrapping-functions",
        ScopePolicy::Everywhere,
        "Call the underlying function directly instead of adding a pass-through wrapper.",
    ),
    general(
        "rust/no-anemic-errors",
        ScopePolicy::AuthoredSource,
        "Preserve underlying error causes in map_err closures and do not branch on formatted error text.",
    ),
    general(
        "rust/no-silent-result-discard",
        ScopePolicy::Everywhere,
        "Do not turn an Err into a new error without its cause, an empty value, or a swallowed filesystem read.",
    ),
    general(
        "rust/no-structural-type-fork",
        ScopePolicy::AuthoredSource,
        "Share or import one owned struct instead of duplicating an identical 3+ field struct shape.",
    ),
    general(
        "rust/no-value-roundtrip",
        ScopePolicy::AuthoredSource,
        "Convert or construct typed values directly instead of round-tripping through to_string().parse() or to_value/from_value.",
    ),
    general(
        "rust/no-decode-to-option",
        ScopePolicy::Everywhere,
        "Propagate or report boundary serde decode failures explicitly instead of collapsing them via .ok() or unwrap_or.",
    ),
    general(
        "rust/no-constant-return-field",
        ScopePolicy::AuthoredSource,
        "Delete struct fields initialized to the same constant across all construction sites and never mutated.",
    ),
    general(
        "rust/no-redundant-owner-prefix",
        ScopePolicy::Everywhere,
        "Drop redundant leading owner-stem prefixes when every field of a non-serde struct repeats the struct stem.",
    ),
    general(
        "rust/no-blocking-in-async",
        ScopePolicy::Everywhere,
        "Do not block async executors with std::thread::sleep, synchronous std::process::Command waits, or inline sleep hold-open scripts.",
    ),
    general(
        "rust/no-query-join-or-tree-reshape",
        ScopePolicy::AuthoredSource,
        "Pre-index inner collections before iterating instead of running nested .find() equijoins, and batch independent awaits.",
    ),
    general(
        "rust/no-contract-appeasement-projection",
        ScopePolicy::AuthoredSource,
        "Preserve Result sum types and owned struct values instead of flattening Ok/Err into product envelopes or cloning fields into a parallel struct of the same type.",
    ),
    house_style(
        "rust/no-inline-comment",
        "Put rationale and history in the commit body or field notes instead of inline comments.",
    ),
    house_style(
        "rust/no-inline-tests",
        "Validate via real CLI smoke runs instead of inline unit tests; keep test = false and doctest = false on Cargo targets.",
    ),
];

pub(super) fn row(id: &str) -> Option<&'static RuleRow> {
    RULES.iter().find(|row| row.id == id)
}
