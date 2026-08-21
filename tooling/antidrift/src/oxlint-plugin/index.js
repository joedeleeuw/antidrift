import packageMetadata from "../../package.json" with { type: "json" };

import { createSyntaxRules } from "../syntax-rules.mjs";
import ruleNoRawReactNativeTouchables from "./rules/no-raw-react-native-touchables.js";
import { noServiceConstructorImportsRule } from "./anti-slop/effect/rules/no-service-constructor-imports.js";
import { noChainedTypeAssertionsRule } from "./anti-slop/rules/no-chained-type-assertions.js";
import { noConditionalEmptyObjectSpreadRule } from "./anti-slop/rules/no-conditional-empty-object-spread.js";
import { noModuleMockingRule } from "./anti-slop/rules/no-module-mocking.js";
import { noObjectParametersRule } from "./anti-slop/rules/no-object-parameters.js";
import { noReflectApplyRule } from "./anti-slop/rules/no-reflect-apply.js";
import { noReflectGetRule } from "./anti-slop/rules/no-reflect-get.js";
import { noRuntimeTypeofRule } from "./anti-slop/rules/no-runtime-typeof.js";
import { noForbiddenTermInSymbolNamesRule } from "./anti-slop/rules/no-shape-in-symbol-names.js";
import { noUnknownParametersRule } from "./anti-slop/rules/no-unknown-parameters.js";
import { noUnknownReturnsRule } from "./anti-slop/rules/no-unknown-returns.js";
import { noUnknownTypeAliasesRule } from "./anti-slop/rules/no-unknown-type-aliases.js";
import { noUnsafeDictionaryTypeRule } from "./anti-slop/rules/no-unsafe-dictionary-type.js";
import { requireSafetyCommentForTypeAssertionRule } from "./anti-slop/rules/require-safety-comment-for-type-assertion.js";

const rules = {
  ...createSyntaxRules(),
  "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
  "no-module-mocking": noModuleMockingRule,
  "no-object-parameters": noObjectParametersRule,
  "no-reflect-apply": noReflectApplyRule,
  "no-reflect-get": noReflectGetRule,
  "no-raw-react-native-touchables": ruleNoRawReactNativeTouchables(),
  "no-runtime-typeof": noRuntimeTypeofRule,
  "no-service-constructor-imports": noServiceConstructorImportsRule,
  "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
  "no-unknown-parameters": noUnknownParametersRule,
  "no-unknown-returns": noUnknownReturnsRule,
  "no-unknown-type-aliases": noUnknownTypeAliasesRule,
  "no-unsafe-cast-chain": noChainedTypeAssertionsRule,
  "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
  "require-safety-comment-for-type-assertion":
    requireSafetyCommentForTypeAssertionRule,
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/oxlint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
