mod directives;
pub mod tsrslint_rules;

use antidrift_kernel::rule::Rule;

#[must_use]
pub fn all_rules() -> Vec<Box<dyn Rule>> {
    directives::rules()
}
