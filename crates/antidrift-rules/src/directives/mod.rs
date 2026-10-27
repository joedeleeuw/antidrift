mod no_as_never;
mod no_debug_residue_filenames;

use antidrift_kernel::rule::Rule;
use no_as_never::NoAsNeverRule;
use no_debug_residue_filenames::NoDebugResidueFilenamesRule;

#[must_use]
pub(crate) fn rules() -> Vec<Box<dyn Rule>> {
    vec![
        Box::new(NoAsNeverRule),
        Box::new(NoDebugResidueFilenamesRule),
    ]
}
