mod alias_usage_scan;
mod anemic_error_fallback;
mod classifier_schema;
pub mod docs_source_policy;
pub mod line_caps;
pub mod no_anemic_errors;
pub mod no_as_never;
pub mod no_branch_tree;
pub mod no_dated_comments;
pub mod no_debug_residue_filenames;
pub mod no_default_export_in_domain;
pub mod no_host_path_literal;
pub mod no_mutable_let_alias;
pub mod no_partial_record_satisfies;
pub mod no_reexport_only_module;
pub mod no_todo_without_issue;
pub mod no_tutorial_comments;
pub mod no_unknown_type_aliases;
pub mod no_unsafe_cast_chain;

use tsrslint::rule::Rule;

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &docs_source_policy::DEFAULT_RULE,
        &line_caps::MODULE_RULE,
        &line_caps::FUNCTION_RULE,
        &line_caps::COMPONENT_RULE,
        &no_anemic_errors::DEFAULT_RULE,
        &no_as_never::DEFAULT_RULE,
        &no_branch_tree::DEFAULT_RULE,
        &no_dated_comments::DEFAULT_RULE,
        &no_debug_residue_filenames::DEFAULT_RULE,
        &no_default_export_in_domain::DEFAULT_RULE,
        &no_host_path_literal::DEFAULT_RULE,
        &no_mutable_let_alias::DEFAULT_RULE,
        &no_partial_record_satisfies::DEFAULT_RULE,
        &no_reexport_only_module::DEFAULT_RULE,
        &no_todo_without_issue::DEFAULT_RULE,
        &no_tutorial_comments::DEFAULT_RULE,
        &no_unknown_type_aliases::DEFAULT_RULE,
        &no_unsafe_cast_chain::DEFAULT_RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    if let Some(rule) = line_caps::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    match name {
        docs_source_policy::RULE_NAME | "docs-source-policy" => Ok(Some(Box::new(
            docs_source_policy::DocsSourcePolicy::from_options(options)?,
        ))),
        no_anemic_errors::RULE_NAME | "no-anemic-errors" => Ok(Some(Box::new(
            no_anemic_errors::NoAnemicErrors::from_options(options)?,
        ))),
        no_as_never::RULE_NAME | "no-as-never" => Ok(Some(Box::new(
            no_as_never::NoAsNever::from_options(options)?,
        ))),
        no_branch_tree::RULE_NAME | "no-branch-tree" => Ok(Some(Box::new(
            no_branch_tree::NoBranchTree::from_options(options)?,
        ))),
        no_dated_comments::RULE_NAME | "no-dated-comments" => Ok(Some(Box::new(
            no_dated_comments::NoDatedComments::from_options(options)?,
        ))),
        no_debug_residue_filenames::RULE_NAME | "no-debug-residue-filenames" => Ok(Some(Box::new(
            no_debug_residue_filenames::NoDebugResidueFilenames::from_options(options)?,
        ))),
        no_default_export_in_domain::RULE_NAME | "no-default-export-in-domain" => Ok(Some(
            Box::new(no_default_export_in_domain::NoDefaultExportInDomain::from_options(options)?),
        )),
        no_host_path_literal::RULE_NAME | "no-host-path-literal" => Ok(Some(Box::new(
            no_host_path_literal::NoHostPathLiteral::from_options(options)?,
        ))),
        no_mutable_let_alias::RULE_NAME | "no-mutable-let-alias" => Ok(Some(Box::new(
            no_mutable_let_alias::NoMutableLetAlias::from_options(options)?,
        ))),
        no_partial_record_satisfies::RULE_NAME | "no-partial-record-satisfies" => Ok(Some(
            Box::new(no_partial_record_satisfies::NoPartialRecordSatisfies::from_options(options)?),
        )),
        no_reexport_only_module::RULE_NAME | "no-reexport-only-module" => Ok(Some(Box::new(
            no_reexport_only_module::NoReexportOnlyModule::from_options(options)?,
        ))),
        no_todo_without_issue::RULE_NAME | "no-todo-without-issue" => Ok(Some(Box::new(
            no_todo_without_issue::NoTodoWithoutIssue::from_options(options)?,
        ))),
        no_tutorial_comments::RULE_NAME | "no-tutorial-comments" => Ok(Some(Box::new(
            no_tutorial_comments::NoTutorialComments::from_options(options)?,
        ))),
        no_unknown_type_aliases::RULE_NAME | "no-unknown-type-aliases" => Ok(Some(Box::new(
            no_unknown_type_aliases::NoUnknownTypeAliases::from_options(options)?,
        ))),
        no_unsafe_cast_chain::RULE_NAME | "no-unsafe-cast-chain" => Ok(Some(Box::new(
            no_unsafe_cast_chain::NoUnsafeCastChain::from_options(options)?,
        ))),
        _ => Ok(None),
    }
}
