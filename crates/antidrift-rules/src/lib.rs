mod directives;
mod lifecycle_async;
mod react_ui;
mod security_boundaries;
mod test_oracle;
pub mod tsrslint_rules;
mod typed_contracts;

use antidrift_kernel::rule::Rule;

#[must_use]
pub fn all_rules() -> Vec<Box<dyn Rule>> {
    let mut rules = Vec::new();
    rules.extend(directives::rules());
    rules.extend(react_ui::rules());
    rules.extend(lifecycle_async::rules());
    rules.extend(security_boundaries::rules());
    rules.extend(test_oracle::rules());
    rules.extend(typed_contracts::rules());
    rules
}
