use crate::diagnostic::{RuleDiagnostic, RuleFix, Severity};
use crate::directives::DirectiveSet;
use crate::json_manifest::{PackageJsonManifest, parse_package_json_manifest};
use crate::registries::PolicyRegistries;
use crate::semantic_facts::SemanticFact;
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

fn is_package_json_path(file_path: &str) -> bool {
    let normalized = file_path.replace('\\', "/");
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    file_name == "package.json"
}

#[derive(Debug, Clone)]
pub struct ReportDiagnostic {
    pub span: Span,
    pub message_id: Option<String>,
    pub message: String,
    pub fix: Option<RuleFix>,
}

pub struct RuleContext<'a, 'b> {
    pub file_path: &'b str,
    pub source_text: &'a str,
    pub line_index: &'b LineIndex,
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
}

impl RuleContext<'_, '_> {
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
    let mut diagnostics = Vec::new();
    let facts = Vec::new();

    if is_package_json_path(request.file_path) {
        let manifest = parse_package_json_manifest(request.source_text);
        run_active_rules(
            request,
            rules,
            &line_index,
            ParsedRuleInput::Package(manifest.as_ref()),
            &mut diagnostics,
        );
        return LintFileOutput { diagnostics, facts };
    }

    let allocator = Allocator::default();
    let source_type =
        SourceType::from_path(Path::new(request.file_path)).unwrap_or_else(|_| SourceType::tsx());
    let parsed = Parser::new(&allocator, request.source_text, source_type).parse();
    for parse_err in &parsed.diagnostics {
        let span = parse_err.labels.first().map_or(Span::new(0, 0), |label| {
            let start = label.offset();
            Span::new(start, start.saturating_add(label.len()))
        });
        diagnostics.push(RuleDiagnostic {
            rule_id: "syntax-error".to_string(),
            message_id: Some("syntaxError".to_string()),
            message: parse_err.message.to_string(),
            severity: Severity::Error,
            span,
            location: line_index.diagnostic_location(request.source_text, span),
            fix: None,
        });
    }
    let semantic_ret = SemanticBuilder::new().with_cfg(true).build(&parsed.program);
    let mut directive_set =
        DirectiveSet::from_comments(&parsed.program.comments, request.source_text, &line_index);

    run_active_rules(
        request,
        rules,
        &line_index,
        ParsedRuleInput::Script {
            program: &parsed.program,
            semantic: &semantic_ret.semantic,
        },
        &mut diagnostics,
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

#[derive(Clone, Copy)]
enum ParsedRuleInput<'a> {
    Package(Option<&'a PackageJsonManifest>),
    Script {
        program: &'a Program<'a>,
        semantic: &'a Semantic<'a>,
    },
}

fn run_active_rules<'a>(
    request: &LintFileRequest<'a>,
    rules: &[Box<dyn Rule>],
    line_index: &LineIndex,
    parsed: ParsedRuleInput<'a>,
    diagnostics: &mut Vec<RuleDiagnostic>,
) {
    let (program, semantic, package_json) = match parsed {
        ParsedRuleInput::Package(pkg) => (None, None, pkg),
        ParsedRuleInput::Script { program, semantic } => (Some(program), Some(semantic), None),
    };
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
        };
        rule.run(&mut ctx);
    }
}
