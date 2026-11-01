mod abort_guards;
pub mod await_waterfall;
pub mod icon_button_requires_tooltip;
pub mod jsx_primitives;
mod lifecycle_state_frame;
pub mod no_adhoc_loader;
pub mod no_calling_components_as_functions;
pub mod no_duplicated_conditional_classnames;
pub mod no_handrolled_resource_lifecycle_cells;
pub mod no_hookless_use_function;
pub mod no_impure_render_call;
pub mod no_inline_style_colors;
pub mod no_omitted_prop_respread;
pub mod no_physical_properties;
pub mod no_query_envelope_leak;
pub mod no_query_join_or_tree_reshape;
pub mod no_unformatted_number;
pub mod no_unstable_render_default_collection;
mod omitted_prop_keys;
mod process_lifecycle_loa;
mod render_body_primitives;
mod render_scope;
pub mod require_dir_on_rendered_name;
pub mod require_stable_snapshot;
mod shadow_state_mirror;
pub mod ui_conventions;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn typescript_only_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::everywhere(&no_impure_render_call::DEFAULT_RULE),
        CatalogRule::everywhere(&no_query_envelope_leak::DEFAULT_RULE),
        CatalogRule::new(
            &no_query_join_or_tree_reshape::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::configured_everywhere(&icon_button_requires_tooltip::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_adhoc_loader::DEFAULT_RULE),
        CatalogRule::everywhere(&ui_conventions::NO_AMBIENT_HOTKEY_FORMAT),
        CatalogRule::everywhere(&no_calling_components_as_functions::DEFAULT_RULE),
        CatalogRule::everywhere(&jsx_primitives::NO_CENTERED_SCROLL_COLUMN),
        CatalogRule::everywhere(&jsx_primitives::NO_DIALOG_TRIGGER_MENU_ITEM),
        CatalogRule::everywhere(&jsx_primitives::NO_DISABLED_TOOLTIP_TRIGGER),
        CatalogRule::configured_everywhere(&no_duplicated_conditional_classnames::DEFAULT_RULE),
        CatalogRule::everywhere(&no_handrolled_resource_lifecycle_cells::DEFAULT_RULE),
        CatalogRule::everywhere(&no_hookless_use_function::DEFAULT_RULE),
        CatalogRule::everywhere(&no_inline_style_colors::DEFAULT_RULE),
        CatalogRule::everywhere(&no_omitted_prop_respread::DEFAULT_RULE),
        CatalogRule::everywhere(&no_physical_properties::DEFAULT_RULE),
        CatalogRule::everywhere(&jsx_primitives::NO_PORTAL_UNDER_INTERACTIVE_ANCESTOR),
        CatalogRule::everywhere(&ui_conventions::NO_RAW_FOREGROUND_OPACITY),
        CatalogRule::configured_everywhere(&no_unformatted_number::DEFAULT_RULE),
        CatalogRule::everywhere(&no_unstable_render_default_collection::DEFAULT_RULE),
        CatalogRule::everywhere(&jsx_primitives::REQUIRE_DETACHED_LABEL_SHAPE),
        CatalogRule::configured_everywhere(&require_dir_on_rendered_name::DEFAULT_RULE),
        CatalogRule::everywhere(&ui_conventions::REQUIRE_EFFECT_DEPS),
        CatalogRule::configured_everywhere(&ui_conventions::REQUIRE_EXHAUSTIVE_PANIC),
        CatalogRule::everywhere(&require_stable_snapshot::DEFAULT_RULE),
    ]
}
