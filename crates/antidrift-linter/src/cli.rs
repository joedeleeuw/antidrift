use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputFormat {
    Human,
    Json,
    Sarif,
}

#[derive(Debug, Clone)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "CLI flag switches are independent boolean options"
)]
pub(crate) struct CliArgs {
    pub(crate) format: OutputFormat,
    pub(crate) fix: bool,
    pub(crate) prune_suppressions: bool,
    pub(crate) suppress_rules: Vec<String>,
    pub(crate) suppressions_path: PathBuf,
    pub(crate) semantic_facts_out: Option<PathBuf>,
    pub(crate) batch_json: Option<String>,
    pub(crate) report_unused_directives: bool,
    pub(crate) list_rules: bool,
    pub(crate) paths: Vec<PathBuf>,
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            format: OutputFormat::Human,
            fix: false,
            prune_suppressions: false,
            suppress_rules: Vec::new(),
            suppressions_path: PathBuf::from("eslint-suppressions.json"),
            semantic_facts_out: None,
            batch_json: None,
            report_unused_directives: false,
            list_rules: false,
            paths: Vec::new(),
        }
    }
}

pub(crate) fn parse_cli_args<I>(raw_args: I) -> Result<CliArgs, String>
where
    I: IntoIterator<Item = String>,
{
    let mut parsed = CliArgs::default();
    let mut iter = raw_args.into_iter();
    while let Some(arg) = iter.next() {
        apply_single_arg(&arg, &mut iter, &mut parsed)?;
    }
    if parsed.paths.is_empty() && parsed.batch_json.is_none() && !parsed.list_rules {
        parsed.paths.push(PathBuf::from("."));
    }
    Ok(parsed)
}

fn apply_single_arg<I>(arg: &str, iter: &mut I, parsed: &mut CliArgs) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match arg {
        "--fix" => parsed.fix = true,
        "--prune-suppressions" => parsed.prune_suppressions = true,
        "--report-unused-disable-directives" => parsed.report_unused_directives = true,
        "--list-rules" => parsed.list_rules = true,
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
        "--semantic-facts-out" => {
            let val = iter
                .next()
                .ok_or("missing value for --semantic-facts-out")?;
            parsed.semantic_facts_out = Some(PathBuf::from(val));
        }
        "--batch-json" => {
            let val = iter.next().ok_or("missing value for --batch-json")?;
            parsed.batch_json = Some(val);
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
