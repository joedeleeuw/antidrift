use antidrift_kernel::file_role::ProjectPath;
use antidrift_kernel::rule::{
    Ctx as KernelCtx, EmittedDiagnostic, Listener as KernelListener, Rule as KernelRule,
    RuleVisitor as KernelVisitor,
};
use antidrift_kernel::scope_policy::ScopePolicy;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use serde_json::Value;
use tsrs_ast::{Kind, Node};
use tsrs_core::{P, tspath};
use tsrslint::rule::{
    Ctx as HostCtx, Listener as HostListener, Rule as HostRule, RuleDiagnostic,
    RuleMessage as HostRuleMessage, RuleVisitor as HostVisitor,
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct ScopeOptions {
    pub(crate) files: Option<Vec<String>>,
    pub(crate) exclude_files: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RuleScope {
    files: Option<GlobSet>,
    exclude_files: Option<GlobSet>,
}

impl RuleScope {
    pub(crate) const DEFAULT: Self = Self {
        files: None,
        exclude_files: None,
    };

    pub(crate) fn from_scope_options(
        rule_name: &str,
        parsed: &ScopeOptions,
    ) -> Result<Self, String> {
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

    pub(crate) const fn has_explicit_files(&self) -> bool {
        self.files.is_some()
    }

    pub(crate) fn matches(&self, file_name: &str, cwd: &str) -> bool {
        let normalized = tspath::normalize_slashes(file_name);
        let local = antidrift_kernel::provenance::relative_to_cwd(cwd, &normalized);
        self.matches_candidates(&[local.as_str(), normalized.as_str()])
    }

    pub(crate) fn matches_candidates(&self, candidates: &[&str]) -> bool {
        let included = match &self.files {
            Some(set) => candidates.iter().any(|candidate| set.is_match(candidate)),
            None => true,
        };
        let excluded = self
            .exclude_files
            .as_ref()
            .is_some_and(|set| candidates.iter().any(|candidate| set.is_match(candidate)));
        included && !excluded
    }
}

fn compile_glob_set(rule_name: &str, field: &str, patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|source| {
                format!("invalid glob '{pattern}' in {field} for {rule_name}: {source}")
            })?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|source| format!("failed to compile {field} globs for {rule_name}: {source}"))
}

pub(crate) struct SplitOptions {
    pub(crate) scope: ScopeOptions,
    pub(crate) rule_options: Option<Value>,
}

const ENVELOPE_KEYS: &[&str] = &["files", "excludeFiles"];

pub(crate) fn split_scope_envelope(
    rule_name: &str,
    options: Option<&Value>,
) -> Result<SplitOptions, String> {
    let Some(raw) = options else {
        return Ok(SplitOptions {
            scope: ScopeOptions::default(),
            rule_options: None,
        });
    };
    let first = match raw {
        Value::Null => None,
        Value::Array(entries) => entries.first().filter(|entry| !entry.is_null()),
        other => Some(other),
    };
    let Some(Value::Object(fields)) = first else {
        return Ok(SplitOptions {
            scope: ScopeOptions::default(),
            rule_options: first.cloned(),
        });
    };
    let mut envelope = serde_json::Map::new();
    let mut rest = serde_json::Map::new();
    for (key, value) in fields {
        if ENVELOPE_KEYS.contains(&key.as_str()) {
            envelope.insert(key.clone(), value.clone());
        } else {
            rest.insert(key.clone(), value.clone());
        }
    }
    let scope = serde_json::from_value::<ScopeOptions>(Value::Object(envelope))
        .map_err(|source| format!("invalid options for {rule_name}: {source}"))?;
    Ok(SplitOptions {
        scope,
        rule_options: (!rest.is_empty()).then_some(Value::Object(rest)),
    })
}

struct EmptyHostVisitor;

impl HostVisitor for EmptyHostVisitor {
    fn listeners(&self) -> &[HostListener] {
        &[]
    }

    fn visit(&mut self, _ctx: &mut HostCtx, _listener: HostListener, _node: P<Node>) {}
}

struct AdaptedVisitor {
    inner: Box<dyn KernelVisitor>,
    listeners: Vec<HostListener>,
}

fn flush_emitted(emitted: Vec<EmittedDiagnostic>, host: &mut HostCtx) {
    for item in emitted {
        let message = HostRuleMessage::new(item.message.id, item.message.description);
        match item.fixes {
            Some(edits) => host.report_diagnostic_with_fixes(
                RuleDiagnostic {
                    pos: item.pos,
                    end: item.end,
                    message,
                    labeled_ranges: Vec::new(),
                },
                |host_ctx| {
                    edits
                        .into_iter()
                        .map(|edit| {
                            host_ctx.fix_replace_range(edit.pos, edit.end, edit.replacement)
                        })
                        .collect()
                },
            ),
            None => host.report_range(item.pos, item.end, message),
        }
    }
}

impl HostVisitor for AdaptedVisitor {
    fn listeners(&self) -> &[HostListener] {
        &self.listeners
    }

    fn visit(&mut self, host: &mut HostCtx, listener: HostListener, node: P<Node>) {
        let kernel_listener = match listener {
            HostListener::Enter(kind) => KernelListener::Enter(kind),
            HostListener::Exit(kind) => KernelListener::Exit(kind),
            HostListener::AllowPattern(_)
            | HostListener::AllowPatternExit(_)
            | HostListener::NotAllowPattern(_)
            | HostListener::NotAllowPatternExit(_) => return,
        };
        let mut ctx = KernelCtx::new(host.checker, host.program, host.file, host.fix);
        self.inner.visit(&mut ctx, kernel_listener, node);
        flush_emitted(ctx.take_emitted(), host);
    }
}

pub(crate) struct Scoped {
    scope: RuleScope,
    policy: ScopePolicy,
    rule: &'static dyn KernelRule,
}

impl Scoped {
    pub(crate) const fn new(
        scope: RuleScope,
        policy: ScopePolicy,
        rule: &'static dyn KernelRule,
    ) -> Self {
        Self {
            scope,
            policy,
            rule,
        }
    }

    fn admits(&self, ctx: &HostCtx) -> bool {
        let file_name = ctx.file.file_name();
        let cwd = ctx.program.host().get_current_directory();
        if !self.scope.matches(file_name, cwd) {
            return false;
        }
        self.policy.admits(
            file_name,
            ctx.file.text(),
            self.scope.has_explicit_files(),
            || ProjectPath::of(ctx.program, file_name),
        )
    }
}

impl HostRule for Scoped {
    fn name(&self) -> &'static str {
        self.rule.name()
    }

    fn create_visitor(&'static self, host: &mut HostCtx) -> Box<dyn HostVisitor> {
        if !self.admits(host) {
            return Box::new(EmptyHostVisitor);
        }
        let mut ctx = KernelCtx::new(host.checker, host.program, host.file, host.fix);
        let mut inner = self.rule.create_visitor(&mut ctx);
        let mut listeners = Vec::with_capacity(inner.listeners().len());
        let mut enter_source_file = false;
        for &listener in inner.listeners() {
            match listener {
                KernelListener::Enter(Kind::SourceFile) => enter_source_file = true,
                KernelListener::Exit(Kind::SourceFile) => {}
                KernelListener::Enter(kind) => listeners.push(HostListener::Enter(kind)),
                KernelListener::Exit(kind) => listeners.push(HostListener::Exit(kind)),
            }
        }
        if enter_source_file {
            inner.visit(
                &mut ctx,
                KernelListener::Enter(Kind::SourceFile),
                host.file.as_node(),
            );
        }
        flush_emitted(ctx.take_emitted(), host);
        if listeners.is_empty() {
            return Box::new(EmptyHostVisitor);
        }
        Box::new(AdaptedVisitor { inner, listeners })
    }
}
