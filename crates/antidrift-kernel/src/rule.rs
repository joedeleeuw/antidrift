use crate::diagnostic::{RuleDiagnostic, RuleFix, Severity};
use crate::directives::DirectiveSet;
use crate::json_manifest::{PackageJsonManifest, parse_package_json_manifest};
use crate::registries::PolicyRegistries;
use crate::semantic_facts::{SemanticFact, SemanticFactInput, build_semantic_fact};
use crate::span_index::LineIndex;
use crate::ts_resolver::TsDeclarationResolver;
use oxc::allocator::Allocator;
use oxc::ast::ast::Program;
use oxc::parser::Parser;
use oxc::semantic::{Semantic, SemanticBuilder};
use oxc::span::{SourceType, Span};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "file role flags are independent orthogonal predicates"
)]
pub struct FileRole {
    pub is_test: bool,
    pub is_domain: bool,
    pub is_shared: bool,
    pub is_declaration: bool,
    pub is_package_json: bool,
}

impl FileRole {
    #[must_use]
    pub fn from_path(file_path: &str) -> Self {
        let normalized = file_path.replace('\\', "/");
        let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
        let is_test = file_name.contains(".test.")
            || file_name.contains(".spec.")
            || normalized.contains("/__tests__/")
            || normalized.starts_with("__tests__/");
        let is_domain = normalized.starts_with("domain/")
            || normalized.starts_with("model/")
            || normalized.contains("/domain/")
            || normalized.contains("/model/");
        let is_shared =
            normalized.starts_with("packages/shared/") || normalized.contains("/packages/shared/");
        let is_declaration = file_name.ends_with(".d.ts")
            || file_name.ends_with(".d.mts")
            || file_name.ends_with(".d.cts");
        let is_package_json = file_name == "package.json";
        Self {
            is_test,
            is_domain,
            is_shared,
            is_declaration,
            is_package_json,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ReportDiagnostic {
    pub span: Span,
    pub message_id: Option<String>,
    pub message: String,
    pub fix: Option<RuleFix>,
}

#[derive(Debug, Clone)]
pub struct EmitFactRequest {
    pub span: Span,
    pub fact_kind: String,
    pub adapter_id: String,
    pub confidence: String,
    pub provenance: Vec<String>,
    pub payload: Value,
}

pub struct RuleContext<'a, 'b> {
    pub file_path: &'b str,
    pub source_text: &'a str,
    pub line_index: &'b LineIndex,
    pub role: FileRole,
    pub program: Option<&'b Program<'a>>,
    pub semantic: Option<&'b Semantic<'a>>,
    pub package_json: Option<&'b PackageJsonManifest>,
    pub options: &'b Value,
    pub settings: &'b Value,
    pub registries: &'b PolicyRegistries,
    pub resolver: Option<&'b TsDeclarationResolver>,
    active_rule_id: &'static str,
    active_severity: Severity,
    diagnostics: &'b mut Vec<RuleDiagnostic>,
    facts: &'b mut Vec<SemanticFact>,
}

impl<'a> RuleContext<'a, '_> {
    #[must_use]
    pub fn span_text(&self, span: Span) -> &'a str {
        let start = usize::try_from(span.start).unwrap_or(0);
        let end = usize::try_from(span.end).unwrap_or(0);
        self.source_text.get(start..end).unwrap_or("")
    }

    pub fn report(&mut self, report: ReportDiagnostic) {
        let location = self
            .line_index
            .diagnostic_location(self.source_text, report.span);
        self.diagnostics.push(RuleDiagnostic {
            rule_id: self.active_rule_id.to_string(),
            message_id: report.message_id,
            message: report.message,
            severity: self.active_severity,
            span: report.span,
            location,
            fix: report.fix,
        });
    }

    pub fn emit_fact(&mut self, request: EmitFactRequest) {
        let location = Some(
            self.line_index
                .fact_location(self.source_text, request.span),
        );
        let fact = build_semantic_fact(SemanticFactInput {
            fact_kind: request.fact_kind,
            rule_id: self.active_rule_id.to_string(),
            adapter_id: request.adapter_id,
            confidence: request.confidence,
            provenance: request.provenance,
            file_path: self.file_path.to_string(),
            location,
            source_text: Some(self.source_text.to_string()),
            payload: request.payload,
        });
        self.facts.push(fact);
    }
}

pub trait Rule: Send + Sync {
    fn id(&self) -> &'static str;
    fn default_severity(&self) -> Severity {
        Severity::Error
    }
    fn run(&self, ctx: &mut RuleContext<'_, '_>);
}

#[derive(Debug, Clone)]
pub struct RuleActivation {
    pub severity: Severity,
    pub options: Value,
}

pub struct LintFileRequest<'a> {
    pub file_path: &'a str,
    pub source_text: &'a str,
    pub active_rules: &'a BTreeMap<String, RuleActivation>,
    pub settings: &'a Value,
    pub registries: &'a PolicyRegistries,
    pub resolver: Option<&'a TsDeclarationResolver>,
    pub report_unused_directives: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LintFileOutput {
    pub diagnostics: Vec<RuleDiagnostic>,
    pub facts: Vec<SemanticFact>,
}

#[must_use]
pub fn lint_file(request: &LintFileRequest<'_>, rules: &[Box<dyn Rule>]) -> LintFileOutput {
    let line_index = LineIndex::new(request.source_text);
    let role = FileRole::from_path(request.file_path);
    let mut diagnostics = Vec::new();
    let mut facts = Vec::new();

    if role.is_package_json {
        let manifest = parse_package_json_manifest(request.source_text);
        run_active_rules(
            request,
            rules,
            &line_index,
            role,
            (None, None, manifest.as_ref()),
            (&mut diagnostics, &mut facts),
        );
        return LintFileOutput { diagnostics, facts };
    }

    let allocator = Allocator::default();
    let source_type =
        SourceType::from_path(Path::new(request.file_path)).unwrap_or_else(|_| SourceType::tsx());
    let parsed = Parser::new(&allocator, request.source_text, source_type).parse();
    let semantic_ret = SemanticBuilder::new().with_cfg(true).build(&parsed.program);
    let mut directive_set =
        DirectiveSet::from_comments(&parsed.program.comments, request.source_text, &line_index);

    run_active_rules(
        request,
        rules,
        &line_index,
        role,
        (Some(&parsed.program), Some(&semantic_ret.semantic), None),
        (&mut diagnostics, &mut facts),
    );

    let filtered = directive_set.filter_diagnostics(
        diagnostics,
        request.report_unused_directives,
        request.source_text,
        &line_index,
    );
    LintFileOutput {
        diagnostics: filtered,
        facts,
    }
}

fn run_active_rules<'a>(
    request: &LintFileRequest<'a>,
    rules: &[Box<dyn Rule>],
    line_index: &LineIndex,
    role: FileRole,
    parsed: (
        Option<&Program<'a>>,
        Option<&Semantic<'a>>,
        Option<&PackageJsonManifest>,
    ),
    outputs: (&mut Vec<RuleDiagnostic>, &mut Vec<SemanticFact>),
) {
    let (program, semantic, package_json) = parsed;
    let (diagnostics, facts) = outputs;
    let empty_options = Value::Null;

    for rule in rules {
        let short_name = rule.id().strip_prefix("antidrift/").unwrap_or(rule.id());
        let activation = request
            .active_rules
            .get(rule.id())
            .or_else(|| request.active_rules.get(short_name));
        let (severity, options) = match activation {
            Some(act) => (act.severity, &act.options),
            None if request.active_rules.is_empty() => (rule.default_severity(), &empty_options),
            None => (Severity::Off, &empty_options),
        };
        if severity == Severity::Off {
            continue;
        }
        let mut ctx = RuleContext {
            file_path: request.file_path,
            source_text: request.source_text,
            line_index,
            role,
            program,
            semantic,
            package_json,
            options,
            settings: request.settings,
            registries: request.registries,
            resolver: request.resolver,
            active_rule_id: rule.id(),
            active_severity: severity,
            diagnostics,
            facts,
        };
        rule.run(&mut ctx);
    }
}
