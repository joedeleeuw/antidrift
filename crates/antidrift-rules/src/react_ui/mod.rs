use antidrift_kernel::rule::Rule;

#[must_use]
pub(crate) fn rules() -> Vec<Box<dyn Rule>> {
    Vec::new()
}
