mod abort_guards;
pub mod await_waterfall;
pub mod icon_button_requires_tooltip;
mod lifecycle_state_frame;
pub mod no_adhoc_loader;
pub mod no_ambient_hotkey_format;
pub mod no_calling_components_as_functions;
pub mod no_centered_scroll_column;
pub mod no_dialog_trigger_menu_item;
pub mod no_disabled_tooltip_trigger;
pub mod no_duplicated_conditional_classnames;
pub mod no_handrolled_resource_lifecycle_cells;
pub mod no_hookless_use_function;
pub mod no_impure_render_call;
pub mod no_inline_style_colors;
pub mod no_omitted_prop_respread;
pub mod no_physical_properties;
pub mod no_portal_under_interactive_ancestor;
pub mod no_query_envelope_leak;
pub mod no_query_join_or_tree_reshape;
pub mod no_raw_foreground_opacity;
pub mod no_unformatted_number;
pub mod no_unstable_render_default_collection;
mod omitted_prop_keys;
mod process_lifecycle_loa;
mod render_body_primitives;
mod render_scope;
pub mod require_detached_label_shape;
pub mod require_dir_on_rendered_name;
pub mod require_effect_deps;
pub mod require_exhaustive_panic;
pub mod require_stable_snapshot;
mod shadow_state_mirror;

use icon_button_requires_tooltip::IconButtonRequiresTooltip;
use no_adhoc_loader::NoAdhocLoader;
use no_ambient_hotkey_format::NoAmbientHotkeyFormat;
use no_calling_components_as_functions::NoCallingComponentsAsFunctions;
use no_centered_scroll_column::NoCenteredScrollColumn;
use no_dialog_trigger_menu_item::NoDialogTriggerMenuItem;
use no_disabled_tooltip_trigger::NoDisabledTooltipTrigger;
use no_duplicated_conditional_classnames::NoDuplicatedConditionalClassnames;
use no_handrolled_resource_lifecycle_cells::NoHandrolledResourceLifecycleCells;
use no_hookless_use_function::NoHooklessUseFunction;
use no_impure_render_call::NoImpureRenderCall;
use no_inline_style_colors::NoInlineStyleColors;
use no_omitted_prop_respread::NoOmittedPropRespread;
use no_physical_properties::NoPhysicalProperties;
use no_portal_under_interactive_ancestor::NoPortalUnderInteractiveAncestor;
use no_query_envelope_leak::NoQueryEnvelopeLeak;
use no_query_join_or_tree_reshape::NoQueryJoinOrTreeReshape;
use no_raw_foreground_opacity::NoRawForegroundOpacity;
use no_unformatted_number::NoUnformattedNumber;
use no_unstable_render_default_collection::NoUnstableRenderDefaultCollection;
use require_detached_label_shape::RequireDetachedLabelShape;
use require_dir_on_rendered_name::RequireDirOnRenderedName;
use require_effect_deps::RequireEffectDeps;
use require_exhaustive_panic::RequireExhaustivePanic;
use require_stable_snapshot::RequireStableSnapshot;
use tsrslint::rule::Rule;

#[must_use]
pub fn typescript_only_rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_impure_render_call::DEFAULT_RULE,
        &no_query_envelope_leak::DEFAULT_RULE,
        &no_query_join_or_tree_reshape::DEFAULT_RULE,
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<&'static dyn Rule> {
    vec![
        &icon_button_requires_tooltip::DEFAULT_RULE,
        &no_adhoc_loader::DEFAULT_RULE,
        &no_ambient_hotkey_format::DEFAULT_RULE,
        &no_calling_components_as_functions::DEFAULT_RULE,
        &no_centered_scroll_column::DEFAULT_RULE,
        &no_dialog_trigger_menu_item::DEFAULT_RULE,
        &no_disabled_tooltip_trigger::DEFAULT_RULE,
        &no_duplicated_conditional_classnames::DEFAULT_RULE,
        &no_handrolled_resource_lifecycle_cells::DEFAULT_RULE,
        &no_hookless_use_function::DEFAULT_RULE,
        &no_inline_style_colors::DEFAULT_RULE,
        &no_omitted_prop_respread::DEFAULT_RULE,
        &no_physical_properties::DEFAULT_RULE,
        &no_portal_under_interactive_ancestor::DEFAULT_RULE,
        &no_raw_foreground_opacity::DEFAULT_RULE,
        &no_unformatted_number::DEFAULT_RULE,
        &no_unstable_render_default_collection::DEFAULT_RULE,
        &require_detached_label_shape::DEFAULT_RULE,
        &require_dir_on_rendered_name::DEFAULT_RULE,
        &require_effect_deps::DEFAULT_RULE,
        &require_exhaustive_panic::DEFAULT_RULE,
        &require_stable_snapshot::DEFAULT_RULE,
    ]
}

fn boxed<R: Rule + 'static>(rule: Result<R, String>) -> Result<Option<Box<dyn Rule>>, String> {
    Ok(Some(Box::new(rule?)))
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name.strip_prefix("antidrift/").unwrap_or(name) {
        "icon-button-requires-tooltip" => boxed(IconButtonRequiresTooltip::from_options(options)),
        "no-adhoc-loader" => boxed(NoAdhocLoader::from_options(options)),
        "no-ambient-hotkey-format" => boxed(NoAmbientHotkeyFormat::from_options(options)),
        "no-calling-components-as-functions" => {
            boxed(NoCallingComponentsAsFunctions::from_options(options))
        }
        "no-centered-scroll-column" => boxed(NoCenteredScrollColumn::from_options(options)),
        "no-dialog-trigger-menu-item" => boxed(NoDialogTriggerMenuItem::from_options(options)),
        "no-disabled-tooltip-trigger" => boxed(NoDisabledTooltipTrigger::from_options(options)),
        "no-duplicated-conditional-classnames" => {
            boxed(NoDuplicatedConditionalClassnames::from_options(options))
        }
        "no-handrolled-resource-lifecycle-cells" => {
            boxed(NoHandrolledResourceLifecycleCells::from_options(options))
        }
        "no-hookless-use-function" => boxed(NoHooklessUseFunction::from_options(options)),
        "no-impure-render-call" => boxed(NoImpureRenderCall::from_options(options)),
        "no-inline-style-colors" => boxed(NoInlineStyleColors::from_options(options)),
        "no-omitted-prop-respread" => boxed(NoOmittedPropRespread::from_options(options)),
        "no-physical-properties" => boxed(NoPhysicalProperties::from_options(options)),
        "no-portal-under-interactive-ancestor" => {
            boxed(NoPortalUnderInteractiveAncestor::from_options(options))
        }
        "no-query-envelope-leak" => boxed(NoQueryEnvelopeLeak::from_options(options)),
        "no-query-join-or-tree-reshape" => boxed(NoQueryJoinOrTreeReshape::from_options(options)),
        "no-raw-foreground-opacity" => boxed(NoRawForegroundOpacity::from_options(options)),
        "no-unformatted-number" => boxed(NoUnformattedNumber::from_options(options)),
        "no-unstable-render-default-collection" => {
            boxed(NoUnstableRenderDefaultCollection::from_options(options))
        }
        "require-detached-label-shape" => boxed(RequireDetachedLabelShape::from_options(options)),
        "require-dir-on-rendered-name" => boxed(RequireDirOnRenderedName::from_options(options)),
        "require-effect-deps" => boxed(RequireEffectDeps::from_options(options)),
        "require-exhaustive-panic" => boxed(RequireExhaustivePanic::from_options(options)),
        "require-stable-snapshot" => boxed(RequireStableSnapshot::from_options(options)),
        _ => Ok(None),
    }
}
