import {
  ruleNoAsyncArrayMethod,
  ruleNoHandrolledResourceLifecycleCells,
  ruleNoInlineStructuralTypeAtUseSite,
  ruleNoRawFetchInComponent,
  ruleNoShatteredIngestedEntityState,
  ruleNoStatusLiteralInType,
  ruleRequireAuthzCheck,
} from "./semantic-adapters/local-ast-rules.mjs";
import ruleNoCallingComponentsAsFunctions from "./oxlint-plugin/rules/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "./oxlint-plugin/rules/no-duplicated-conditional-classnames.js";
import ruleNoDuplicatedObjectFieldBlocks from "./oxlint-plugin/rules/no-duplicated-object-field-blocks.js";
import ruleNoNonindependentTestOracle from "./oxlint-plugin/rules/no-nonindependent-test-oracle.js";
import ruleNoQueryDataTypeParameters from "./oxlint-plugin/rules/no-query-data-type-parameters.js";
import ruleNoSilentEmptyDetectionFallback from "./oxlint-plugin/rules/no-silent-empty-detection-fallback.js";
import ruleNoStaticPropertyLoop from "./oxlint-plugin/rules/no-static-property-loop.js";
import ruleRequireEffectDeps from "./oxlint-plugin/rules/require-effect-deps.js";

// Rules that need no type information. Oxlint's JS plugin API cannot run
// type-aware rules, so these are exactly the set that both runtimes can host:
// Oxlint for speed, ESLint for consumers who do not run Oxlint at all.
// Registered by both plugin entry points from this one definition.
export function createSyntaxRules() {
  return {
    "no-async-array-method": ruleNoAsyncArrayMethod(),
    "no-calling-components-as-functions": ruleNoCallingComponentsAsFunctions(),
    "no-duplicated-conditional-classnames":
      ruleNoDuplicatedConditionalClassnames(),
    "no-duplicated-object-field-blocks": ruleNoDuplicatedObjectFieldBlocks(),
    "no-handrolled-resource-lifecycle-cells":
      ruleNoHandrolledResourceLifecycleCells(),
    "no-inline-structural-type-at-use-site":
      ruleNoInlineStructuralTypeAtUseSite(),
    "no-nonindependent-test-oracle": ruleNoNonindependentTestOracle(),
    "no-query-data-type-parameters": ruleNoQueryDataTypeParameters(),
    "no-raw-fetch-in-component": ruleNoRawFetchInComponent(),
    "no-shattered-ingested-entity-state": ruleNoShatteredIngestedEntityState(),
    "no-silent-empty-detection-fallback": ruleNoSilentEmptyDetectionFallback(),
    "no-static-property-loop": ruleNoStaticPropertyLoop(),
    "no-status-literal-in-type": ruleNoStatusLiteralInType(),
    "require-authz-check": ruleRequireAuthzCheck(),
    "require-effect-deps": ruleRequireEffectDeps,
  };
}
