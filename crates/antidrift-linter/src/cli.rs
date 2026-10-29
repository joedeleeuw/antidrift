use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputFormat {
    Human,
    Json,
    Sarif,
}

#[derive(Debug, Clone)]
pub(crate) struct CliArgs {
    pub(crate) format: OutputFormat,
    pub(crate) fix: bool,
    pub(crate) prune_suppressions: bool,
    pub(crate) suppress_rules: Vec<String>,
    pub(crate) suppressions_path: PathBuf,
    pub(crate) report_unused_directives: bool,
    pub(crate) paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub(crate) enum CliAction {
    ListRules,
    BatchJson(String),
    Lint(CliArgs),
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            format: OutputFormat::Human,
            fix: false,
            prune_suppressions: false,
            suppress_rules: Vec::new(),
            suppressions_path: PathBuf::from("eslint-suppressions.json"),
            report_unused_directives: false,
            paths: Vec::new(),
        }
    }
}

pub(crate) fn parse_cli_args<I>(raw_args: I) -> Result<CliAction, String>
where
    I: IntoIterator<Item = String>,
{
    let mut parsed = CliArgs::default();
    let mut batch_json: Option<String> = None;
    let mut list_rules = false;
    let mut iter = raw_args.into_iter();
    while let Some(arg) = iter.next() {
        apply_single_arg(
            &arg,
            &mut iter,
            &mut parsed,
            &mut batch_json,
            &mut list_rules,
        )?;
    }
    if list_rules {
        return Ok(CliAction::ListRules);
    }
    if let Some(spec) = batch_json {
        return Ok(CliAction::BatchJson(spec));
    }
    if parsed.paths.is_empty() {
        parsed.paths.push(PathBuf::from("."));
    }
    Ok(CliAction::Lint(parsed))
}

fn apply_single_arg<I>(
    arg: &str,
    iter: &mut I,
    parsed: &mut CliArgs,
    batch_json: &mut Option<String>,
    list_rules: &mut bool,
) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match arg {
        "--fix" => parsed.fix = true,
        "--prune-suppressions" => parsed.prune_suppressions = true,
        "--report-unused-disable-directives" => parsed.report_unused_directives = true,
        "--list-rules" => *list_rules = true,
        "--format" => {
            let val = iter.next().ok_or("missing value for --format")?;
            parsed.format = parse_format(&val)?;
        }
        "--suppress-rule" => {
            let val = iter.next().ok_or("missing value for --suppress-rule")?;
            parsed.suppress_rules.push(val);
        }
        "--suppressions-location" => {
            let val = iter
                .next()
                .ok_or("missing value for --suppressions-location")?;
            parsed.suppressions_path = PathBuf::from(val);
        }
        "--batch-json" => {
            let val = iter.next().ok_or("missing value for --batch-json")?;
            *batch_json = Some(val);
        }
        other if other.starts_with('-') => {
            return Err(format!("unknown flag: {other}"));
        }
        path => parsed.paths.push(PathBuf::from(path)),
    }
    Ok(())
}

fn parse_format(raw: &str) -> Result<OutputFormat, String> {
    match raw {
        "human" | "stylish" => Ok(OutputFormat::Human),
        "json" => Ok(OutputFormat::Json),
        "sarif" => Ok(OutputFormat::Sarif),
        other => Err(format!(
            "unsupported format '{other}' (expected human, json, or sarif)"
        )),
    }
}
