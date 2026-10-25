import { ruleNoAsyncArrayMethod } from "./semantic-adapters/syntax/async-array.ts";
import { ruleNoHandrolledResourceLifecycleCells } from "./semantic-adapters/syntax/resource-lifecycle.ts";
import { ruleRequireAuthzCheck } from "./semantic-adapters/syntax/authz.ts";
import ruleNoCallingComponentsAsFunctions from "./oxlint-plugin/rules/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "./oxlint-plugin/rules/no-duplicated-conditional-classnames.js";
import ruleNoNonindependentTestOracle from "./oxlint-plugin/rules/no-nonindependent-test-oracle.js";
import ruleNoSentinelAbsenceFallback from "./oxlint-plugin/rules/no-sentinel-absence-fallback.js";
import ruleNoVagueNames from "./eslint-plugin/rules/no-vague-names.js";
import ruleRequireEffectDeps from "./oxlint-plugin/rules/require-effect-deps.js";
import ruleNoRedeclaredOwnedUnion from "./oxlint-plugin/rules/no-redeclared-owned-union.js";
import ruleNoRepoStateMirrorAssertion from "./oxlint-plugin/rules/no-repo-state-mirror-assertion.js";

// Rules that need no type information. Single-owned by the Oxlint plugin
// entry point per docs/lint-rule-parity.md; selected portable rules may also
// be exported by ESLint while remaining enabled by at most one runtime.
export function createSyntaxRules() {
  return {
    "no-async-array-method": ruleNoAsyncArrayMethod,
    "no-calling-components-as-functions": ruleNoCallingComponentsAsFunctions(),
    "no-duplicated-conditional-classnames":
      ruleNoDuplicatedConditionalClassnames(),
    "no-handrolled-resource-lifecycle-cells":
      ruleNoHandrolledResourceLifecycleCells,
    "no-nonindependent-test-oracle": ruleNoNonindependentTestOracle(),
    "no-redeclared-owned-union": ruleNoRedeclaredOwnedUnion(),
    "no-repo-state-mirror-assertion": ruleNoRepoStateMirrorAssertion(),
    "no-sentinel-absence-fallback": ruleNoSentinelAbsenceFallback(),
    "no-vague-names": ruleNoVagueNames,
    "require-authz-check": ruleRequireAuthzCheck,
    "require-effect-deps": ruleRequireEffectDeps,
  };
}
