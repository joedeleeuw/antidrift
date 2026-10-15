import {
  ruleNoAsyncArrayMethod,
  ruleNoHandrolledResourceLifecycleCells,
  ruleNoRawFetchInComponent,
  ruleNoStatusLiteralInType,
  ruleRequireAuthzCheck,
} from "./semantic-adapters/local-ast-rules.mjs";
import ruleNoCallingComponentsAsFunctions from "./oxlint-plugin/rules/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "./oxlint-plugin/rules/no-duplicated-conditional-classnames.js";
import ruleNoDuplicatedObjectFieldBlocks from "./oxlint-plugin/rules/no-duplicated-object-field-blocks.js";
import ruleNoNonindependentTestOracle from "./oxlint-plugin/rules/no-nonindependent-test-oracle.js";
import ruleNoSchemaLibraryInTest from "./oxlint-plugin/rules/no-schema-library-in-test.js";
import ruleNoSentinelAbsenceFallback from "./oxlint-plugin/rules/no-sentinel-absence-fallback.js";
import ruleNoSilentEmptyDetectionFallback from "./oxlint-plugin/rules/no-silent-empty-detection-fallback.js";
import ruleNoStaticPropertyLoop from "./oxlint-plugin/rules/no-static-property-loop.js";
import ruleNoValidatorOutputOracle from "./oxlint-plugin/rules/no-validator-output-oracle.js";
import ruleRequireEffectDeps from "./oxlint-plugin/rules/require-effect-deps.js";
import ruleNoOpenDictionaryAtBoundary from "./oxlint-plugin/rules/no-open-dictionary-at-boundary.js";
import ruleNoRedeclaredOwnedUnion from "./oxlint-plugin/rules/no-redeclared-owned-union.js";
import ruleNoRepoStateMirrorAssertion from "./oxlint-plugin/rules/no-repo-state-mirror-assertion.js";

// Rules that need no type information. Single-owned by the Oxlint plugin
// entry point per docs/lint-rule-parity.md; selected portable rules may also
// be exported by ESLint while remaining enabled by at most one runtime.
export function createSyntaxRules() {
  return {
    "no-async-array-method": ruleNoAsyncArrayMethod(),
    "no-calling-components-as-functions": ruleNoCallingComponentsAsFunctions(),
    "no-duplicated-conditional-classnames":
      ruleNoDuplicatedConditionalClassnames(),
    "no-duplicated-object-field-blocks": ruleNoDuplicatedObjectFieldBlocks(),
    "no-handrolled-resource-lifecycle-cells":
      ruleNoHandrolledResourceLifecycleCells(),
    "no-nonindependent-test-oracle": ruleNoNonindependentTestOracle(),
    "no-open-dictionary-at-boundary": ruleNoOpenDictionaryAtBoundary(),
    "no-redeclared-owned-union": ruleNoRedeclaredOwnedUnion(),
    "no-repo-state-mirror-assertion": ruleNoRepoStateMirrorAssertion(),
    "no-schema-library-in-test": ruleNoSchemaLibraryInTest(),
    "no-raw-fetch-in-component": ruleNoRawFetchInComponent(),
    "no-sentinel-absence-fallback": ruleNoSentinelAbsenceFallback(),
    "no-silent-empty-detection-fallback": ruleNoSilentEmptyDetectionFallback(),
    "no-static-property-loop": ruleNoStaticPropertyLoop(),
    "no-status-literal-in-type": ruleNoStatusLiteralInType(),
    "no-validator-output-oracle": ruleNoValidatorOutputOracle(),
    "require-authz-check": ruleRequireAuthzCheck(),
    "require-effect-deps": ruleRequireEffectDeps,
  };
}
