import packageMetadata from "../../package.json" with { type: "json" };

import { ruleReactMaxComponentProps } from "./rules/react-max-component-props.js";
import { ruleNoContractAppeasementProjection } from "./rules/no-contract-appeasement-projection.js";
import { ruleNoAppeasementCast } from "./rules/no-appeasement-cast.js";
import { ruleNoNullablePositionalTuple } from "./rules/no-nullable-positional-tuple.js";
import { ruleNoUndercheckedTypePredicate } from "./rules/no-underchecked-type-predicate.js";
import { ruleNoDefensiveShapeProbing } from "./rules/no-defensive-shape-probing.js";
import { ruleNoSqlStringConcat } from "./rules/no-sql-string-concat.js";
import { ruleNoUnsafeDeserialize } from "./rules/no-unsafe-deserialize.js";
import { ruleNoStructuralTypeFork } from "./rules/no-structural-type-fork.js";
import { ruleNoCanonicalModelFork } from "./rules/no-canonical-model-fork.js";
import { ruleNoRedundantZodParse } from "./rules/no-redundant-zod-parse.js";
import { ruleNoParseAsCast } from "./rules/no-parse-as-cast.js";
import { ruleNoAppeasementErasure } from "./rules/no-appeasement-erasure.js";
import { ruleNoIdentitySchemaTransform } from "./rules/no-identity-schema-transform.js";
import { ruleNoExplicitTypeArgumentsOnOwnedApi } from "./rules/no-explicit-type-arguments-on-owned-api.js";
import { ruleRequireConvexReturnValidator } from "./rules/require-convex-return-validator.js";
import { ruleNoSchemaValidatorTranscoding } from "./rules/no-schema-validator-transcoding.js";

const rules = {
  "react-max-component-props": ruleReactMaxComponentProps(),
  "no-contract-appeasement-projection": ruleNoContractAppeasementProjection(),
  "no-appeasement-cast": ruleNoAppeasementCast(),
  "no-nullable-positional-tuple": ruleNoNullablePositionalTuple(),
  "no-underchecked-type-predicate": ruleNoUndercheckedTypePredicate(),
  "no-defensive-shape-probing": ruleNoDefensiveShapeProbing(),
  "no-sql-string-concat": ruleNoSqlStringConcat(),
  "no-unsafe-deserialize": ruleNoUnsafeDeserialize(),
  "no-structural-type-fork": ruleNoStructuralTypeFork(),
  "no-canonical-model-fork": ruleNoCanonicalModelFork(),
  "no-redundant-zod-parse": ruleNoRedundantZodParse(),
  "no-parse-as-cast": ruleNoParseAsCast(),
  "no-appeasement-erasure": ruleNoAppeasementErasure(),
  "no-identity-schema-transform": ruleNoIdentitySchemaTransform(),
  "no-explicit-type-arguments-on-owned-api": ruleNoExplicitTypeArgumentsOnOwnedApi(),
  "require-convex-return-validator": ruleRequireConvexReturnValidator(),
  "no-schema-validator-transcoding": ruleNoSchemaValidatorTranscoding(),
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/eslint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
