import { ruleNoInlineStructuralTypeAtUseSite } from "./rules/no-inline-structural-type-at-use-site.js";
import packageMetadata from "../../package.json" with { type: "json" };

import { ruleReactMaxComponentProps } from "./rules/react-max-component-props.js";
import { ruleNoContractAppeasementProjection } from "./rules/no-contract-appeasement-projection.js";
import { ruleNoNullablePositionalTuple } from "./rules/no-nullable-positional-tuple.js";
import { ruleNoUndercheckedTypePredicate } from "./rules/no-underchecked-type-predicate.js";
import { ruleNoRedundantTypePredicate } from "./rules/no-redundant-type-predicate.js";
import { ruleNoDefensiveShapeProbing } from "./rules/no-defensive-shape-probing.js";
import { ruleNoSqlStringConcat } from "./rules/no-sql-string-concat.js";
import { ruleNoStructuralTypeFork } from "./rules/no-structural-type-fork.js";
import { ruleNoCanonicalModelFork } from "./rules/no-canonical-model-fork.js";
import { ruleNoRedundantZodParse } from "./rules/no-redundant-zod-parse.js";
import { ruleNoAppeasementErasure } from "./rules/no-appeasement-erasure.js";
import { ruleNoIdentitySchemaTransform } from "./rules/no-identity-schema-transform.js";
import { ruleNoExplicitTypeArgumentsOnOwnedApi } from "./rules/no-explicit-type-arguments-on-owned-api.js";
import { ruleRequireConvexReturnValidator } from "./rules/require-convex-return-validator.js";
import { ruleNoSchemaValidatorTranscoding } from "./rules/no-schema-validator-transcoding.js";
import { ruleNoRestatedDependencyType } from "./rules/no-restated-dependency-type.js";
import { ruleNoUnresolvedDependencyTypes } from "./rules/no-unresolved-dependency-types.js";
import { ruleNoRedundantLocalReturnType } from "./rules/no-redundant-local-return-type.js";
import noWrappingFunctionsRule from "./rules/no-wrapping-functions.js";
import noPassThroughParametersRule from "./rules/no-pass-through-parameters.js";
import noVagueNamesRule from "./rules/no-vague-names.js";
import noCompatNamesRule from "./rules/no-compat-names.js";
import { ruleNoRawFetchInComponent } from "../semantic-adapters/syntax/raw-fetch.ts";
import ruleNoDuplicatedConditionalClassnames from "../oxlint-plugin/rules/no-duplicated-conditional-classnames.js";
import ruleNoDuplicatedObjectFieldBlocks from "../oxlint-plugin/rules/no-duplicated-object-field-blocks.js";
import ruleNoNonindependentTestOracle from "../oxlint-plugin/rules/no-nonindependent-test-oracle.js";
import ruleNoOpenDictionaryAtBoundary from "../oxlint-plugin/rules/no-open-dictionary-at-boundary.js";
import ruleNoRawReactNativeTouchables from "../oxlint-plugin/rules/no-raw-react-native-touchables.js";
import ruleNoRedeclaredOwnedUnion from "../oxlint-plugin/rules/no-redeclared-owned-union.js";
import ruleNoSchemaLibraryInTest from "../oxlint-plugin/rules/no-schema-library-in-test.js";
import ruleNoSentinelAbsenceFallback from "../oxlint-plugin/rules/no-sentinel-absence-fallback.js";
import ruleNoSilentEmptyDetectionFallback from "../oxlint-plugin/rules/no-silent-empty-detection-fallback.js";
import ruleNoValidatorOutputOracle from "../oxlint-plugin/rules/no-validator-output-oracle.js";
import { ruleNoServiceConstructorImports } from "./rules/no-service-constructor-imports.js";
import { ruleNoFirstPartyModuleMock } from "./rules/no-first-party-module-mock.js";
import { ruleNoBagReshaper } from "./rules/no-bag-reshaper.js";
import { ruleNoNearDuplicateType } from "./rules/no-near-duplicate-type.js";
import { ruleNoRoundTripWidening } from "./rules/no-round-trip-widening.js";

const rules = {
  "react-max-component-props": ruleReactMaxComponentProps(),
  "no-contract-appeasement-projection": ruleNoContractAppeasementProjection(),
  "no-bag-reshaper": ruleNoBagReshaper(),
  "no-nullable-positional-tuple": ruleNoNullablePositionalTuple(),
  "no-underchecked-type-predicate": ruleNoUndercheckedTypePredicate(),
  "no-redundant-type-predicate": ruleNoRedundantTypePredicate(),
  "no-defensive-shape-probing": ruleNoDefensiveShapeProbing(),
  "no-sql-string-concat": ruleNoSqlStringConcat(),
  "no-structural-type-fork": ruleNoStructuralTypeFork(),
  "no-canonical-model-fork": ruleNoCanonicalModelFork(),
  "no-redundant-zod-parse": ruleNoRedundantZodParse(),
  "no-appeasement-erasure": ruleNoAppeasementErasure(),
  "no-identity-schema-transform": ruleNoIdentitySchemaTransform(),
  "no-explicit-type-arguments-on-owned-api":
    ruleNoExplicitTypeArgumentsOnOwnedApi(),
  "require-convex-return-validator": ruleRequireConvexReturnValidator(),
  "no-schema-validator-transcoding": ruleNoSchemaValidatorTranscoding(),
  "no-restated-dependency-type": ruleNoRestatedDependencyType(),
  "no-unresolved-dependency-types": ruleNoUnresolvedDependencyTypes(),
  "no-redundant-local-return-type": ruleNoRedundantLocalReturnType(),
  "no-service-constructor-imports": ruleNoServiceConstructorImports(),
  "no-first-party-module-mock": ruleNoFirstPartyModuleMock(),
  "no-wrapping-functions": noWrappingFunctionsRule,
  "no-pass-through-parameters": noPassThroughParametersRule,
  "no-vague-names": noVagueNamesRule,
  "no-compat-names": noCompatNamesRule,
  "no-duplicated-conditional-classnames":
    ruleNoDuplicatedConditionalClassnames(),
  "no-duplicated-object-field-blocks": ruleNoDuplicatedObjectFieldBlocks(),
  "no-inline-structural-type-at-use-site":
    ruleNoInlineStructuralTypeAtUseSite(),
  "no-nonindependent-test-oracle": ruleNoNonindependentTestOracle(),
  "no-open-dictionary-at-boundary": ruleNoOpenDictionaryAtBoundary(),
  "no-raw-fetch-in-component": ruleNoRawFetchInComponent,
  "no-raw-react-native-touchables": ruleNoRawReactNativeTouchables(),
  "no-redeclared-owned-union": ruleNoRedeclaredOwnedUnion(),
  "no-schema-library-in-test": ruleNoSchemaLibraryInTest(),
  "no-sentinel-absence-fallback": ruleNoSentinelAbsenceFallback(),
  "no-silent-empty-detection-fallback": ruleNoSilentEmptyDetectionFallback(),
  "no-validator-output-oracle": ruleNoValidatorOutputOracle(),
  "no-near-duplicate-type": ruleNoNearDuplicateType(),
  "no-round-trip-widening": ruleNoRoundTripWidening(),
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/eslint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
