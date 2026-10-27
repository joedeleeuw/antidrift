use antidrift_kernel::rule::{ReportDiagnostic, Rule, RuleContext};
use antidrift_kernel::rule_scope::is_rule_file;

pub(super) struct NoDebugResidueFilenamesRule;

impl Rule for NoDebugResidueFilenamesRule {
    fn id(&self) -> &'static str {
        "antidrift/no-debug-residue-filenames"
    }

    fn run(&self, ctx: &mut RuleContext<'_, '_>) {
        if !is_rule_file(ctx, None) {
            return;
        }
        let Some(program) = ctx.program else {
            return;
        };
        if !has_debug_residue_filename(ctx.file_path) {
            return;
        }
        let filename = ctx.file_path.to_string();
        ctx.report(ReportDiagnostic {
            span: program.span,
            message_id: Some("debugResidue".to_string()),
            message: format!(
                "Filename '{filename}' looks like debug residue. Rename the file to its real intent."
            ),
            fix: None,
        });
    }
}

fn has_debug_residue_filename(file_path: &str) -> bool {
    let normalized = file_path.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or(&normalized);
    if base.is_empty() {
        return false;
    }
    let lower = base.to_ascii_lowercase();
    let without_final_ext = match lower.rfind('.') {
        Some(idx) if idx > 0 => &lower[..idx],
        _ => lower.as_str(),
    };
    for candidate in [lower.as_str(), without_final_ext] {
        if candidate.ends_with("_old")
            || candidate.ends_with("_backup")
            || candidate.ends_with("_temp")
            || candidate.ends_with("_v2")
            || candidate.ends_with(".bak")
            || candidate.ends_with(".old")
            || candidate.ends_with(".backup")
        {
            return true;
        }
    }
    false
}
