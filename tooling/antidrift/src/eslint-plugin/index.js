import packageMetadata from "../../package.json" with { type: "json" };

import { ruleReactMaxComponentProps } from "./rules/react-max-component-props.js";
import { ruleNoContractAppeasementProjection } from "./rules/no-contract-appeasement-projection.js";
import { ruleNoAppeasementCast } from "./rules/no-appeasement-cast.js";
import { ruleNoNullablePositionalTuple } from "./rules/no-nullable-positional-tuple.js";
import { ruleNoUndercheckedTypePredicate } from "./rules/no-underchecked-type-predicate.js";
import { ruleNoRedundantTypePredicate } from "./rules/no-redundant-type-predicate.js";
import { ruleNoSqlStringConcat } from "./rules/no-sql-string-concat.js";
import { ruleNoUnsafeDeserialize } from "./rules/no-unsafe-deserialize.js";
import { ruleNoStructuralTypeFork } from "./rules/no-structural-type-fork.js";
import { ruleNoRedundantZodParse } from "./rules/no-redundant-zod-parse.js";
import { ruleNoAppeasementErasure } from "./rules/no-appeasement-erasure.js";
import { ruleNoIdentitySchemaTransform } from "./rules/no-identity-schema-transform.js";
import { ruleNoExplicitTypeArgumentsOnOwnedApi } from "./rules/no-explicit-type-arguments-on-owned-api.js";
import { ruleRequireConvexReturnValidator } from "./rules/require-convex-return-validator.js";
import { ruleNoSchemaValidatorTranscoding } from "./rules/no-schema-validator-transcoding.js";
import { ruleNoUnresolvedDependencyTypes } from "./rules/no-unresolved-dependency-types.js";
import noWrappingFunctionsRule from "./rules/no-wrapping-functions.js";
import noPassThroughParametersRule from "./rules/no-pass-through-parameters.js";
import noVagueNamesRule from "./rules/no-vague-names.js";
import noCompatNamesRule from "./rules/no-compat-names.js";
import ruleNoCallingComponentsAsFunctions from "../oxlint-plugin/rules/no-calling-components-as-functions.js";
import ruleNoDuplicatedConditionalClassnames from "../oxlint-plugin/rules/no-duplicated-conditional-classnames.js";
import ruleNoNonindependentTestOracle from "../oxlint-plugin/rules/no-nonindependent-test-oracle.js";
import ruleNoRedeclaredOwnedUnion from "../oxlint-plugin/rules/no-redeclared-owned-union.js";
import ruleNoSentinelAbsenceFallback from "../oxlint-plugin/rules/no-sentinel-absence-fallback.js";
import { ruleNoServiceConstructorImports } from "./rules/no-service-constructor-imports.js";
import ruleUnknownInputMustBeDecoded from "./rules/unknown-input-must-be-decoded.js";

const rules = {
  "react-max-component-props": ruleReactMaxComponentProps(),
  "no-contract-appeasement-projection": ruleNoContractAppeasementProjection(),
  "no-appeasement-cast": ruleNoAppeasementCast(),
  "no-nullable-positional-tuple": ruleNoNullablePositionalTuple(),
  "no-underchecked-type-predicate": ruleNoUndercheckedTypePredicate(),
  "no-redundant-type-predicate": ruleNoRedundantTypePredicate(),
  "no-sql-string-concat": ruleNoSqlStringConcat(),
  "no-unsafe-deserialize": ruleNoUnsafeDeserialize(),
  "no-structural-type-fork": ruleNoStructuralTypeFork(),
  "no-redundant-zod-parse": ruleNoRedundantZodParse(),
  "no-appeasement-erasure": ruleNoAppeasementErasure(),
  "no-identity-schema-transform": ruleNoIdentitySchemaTransform(),
  "no-explicit-type-arguments-on-owned-api":
    ruleNoExplicitTypeArgumentsOnOwnedApi(),
  "require-convex-return-validator": ruleRequireConvexReturnValidator(),
  "no-schema-validator-transcoding": ruleNoSchemaValidatorTranscoding(),
  "no-unresolved-dependency-types": ruleNoUnresolvedDependencyTypes(),
  "no-service-constructor-imports": ruleNoServiceConstructorImports(),
  "no-wrapping-functions": noWrappingFunctionsRule,
  "no-pass-through-parameters": noPassThroughParametersRule,
  "no-vague-names": noVagueNamesRule,
  "no-compat-names": noCompatNamesRule,
  "no-calling-components-as-functions": ruleNoCallingComponentsAsFunctions(),
  "no-duplicated-conditional-classnames":
    ruleNoDuplicatedConditionalClassnames(),
  "no-nonindependent-test-oracle": ruleNoNonindependentTestOracle(),
  "no-redeclared-owned-union": ruleNoRedeclaredOwnedUnion(),
  "no-sentinel-absence-fallback": ruleNoSentinelAbsenceFallback(),
  "unknown-input-must-be-decoded": ruleUnknownInputMustBeDecoded(),
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/eslint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
