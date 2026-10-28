use antidrift_kernel::{callgraph, provenance, rule_scope, tsrs_kernel};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor, options_object};

fn extract_patterns(options: Option<&serde_json::Value>, key: &str) -> Vec<String> {
    let map = options_object(options);
    let Some(arr) = map.get(key).and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn matches_scope(file_name: &str, cwd: &str, files: &[String], exclude_files: &[String]) -> bool {
    let normalized = tsrs_kernel::normalize_path(file_name);
    let local = provenance::relative_to_cwd(cwd, &normalized);
    let matches_any = |patterns: &[String]| {
        patterns.iter().any(|pattern| {
            rule_scope::glob_matches(&local, pattern)
                || rule_scope::glob_matches(&normalized, pattern)
        })
    };
    (files.is_empty() || matches_any(files)) && !matches_any(exclude_files)
}

fn build_pass_through_message(name: &str, targets: &[String]) -> RuleMessage {
    RuleMessage::new(
        "passThrough",
        format!(
            "'{name}' is a pass-through variable: this function never reads it and only forwards it to {}. Let that layer obtain it from its owner, or move the work that needs it here.",
            targets.join(", ")
        ),
    )
}

pub struct NoPassThroughParameters {
    files: Vec<String>,
    exclude_files: Vec<String>,
}

impl NoPassThroughParameters {
    pub const DEFAULT: Self = Self {
        files: Vec::new(),
        exclude_files: Vec::new(),
    };
}

pub static DEFAULT_INSTANCE: NoPassThroughParameters = NoPassThroughParameters::DEFAULT;

#[must_use]
pub fn create(options: Option<&serde_json::Value>) -> Box<dyn Rule> {
    Box::new(NoPassThroughParameters {
        files: extract_patterns(options, "files"),
        exclude_files: extract_patterns(options, "excludeFiles"),
    })
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
];

impl Rule for NoPassThroughParameters {
    fn name(&self) -> &'static str {
        "antidrift/no-pass-through-parameters"
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = matches_scope(ctx.file.file_name(), cwd, &self.files, &self.exclude_files);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        for matched in callgraph::find_pass_through_parameters(node, ctx.file, ctx.checker) {
            ctx.report_node(
                matched.name_node,
                build_pass_through_message(&matched.name, &matched.targets),
            );
        }
    }
}
