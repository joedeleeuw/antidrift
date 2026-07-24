import packageMetadata from "../../package.json" with { type: "json" };
import ruleNoCallingComponentsAsFunctions from "./rules/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "./rules/no-duplicated-conditional-classnames.js";
import ruleNoDuplicatedObjectFieldBlocks from "./rules/no-duplicated-object-field-blocks.js";
import ruleNoNonindependentTestOracle from "./rules/no-nonindependent-test-oracle.js";
import ruleNoStaticPropertyLoop from "./rules/no-static-property-loop.js";
import {
  ruleNoAsyncArrayMethod,
  ruleNoHandrolledResourceLifecycleCells,
  ruleNoInlineStructuralTypeAtUseSite,
  ruleNoRawFetchInComponent,
  ruleNoShatteredIngestedEntityState,
  ruleNoStatusLiteralInType,
  ruleRequireAuthzCheck,
} from "../semantic-adapters/local-ast-rules.mjs";
import ruleNoQueryDataTypeParameters from "./rules/no-query-data-type-parameters.js";
import ruleRequireEffectDeps from "./rules/require-effect-deps.js";
import ruleNoSilentEmptyDetectionFallback from "./rules/no-silent-empty-detection-fallback.js";

const rules = {
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

export default {
  meta: {
    name: "@joedeleeuw/antidrift/oxlint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
