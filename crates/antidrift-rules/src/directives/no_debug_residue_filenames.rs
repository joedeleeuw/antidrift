use antidrift_kernel::provenance::relative_to_cwd;
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub const RULE_NAME: &str = "antidrift/no-debug-residue-filenames";

pub struct NoDebugResidueFilenames;

pub static DEFAULT_RULE: NoDebugResidueFilenames = NoDebugResidueFilenames;

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoDebugResidueFilenames {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        let file_name = ctx.file.file_name();
        if !has_debug_residue_filename(file_name) {
            return;
        }
        let display = relative_to_cwd(ctx.program.host().get_current_directory(), file_name);
        let end = i32::try_from(ctx.file.text().len()).unwrap_or(0);
        ctx.report_range(
            0,
            end,
            RuleMessage::new(
                "debugResidue",
                format!(
                    "Filename '{display}' looks like debug residue. Rename the file to its real intent."
                ),
            ),
        );
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
