import noDatedCommentsRule from "./rules/no-dated-comments.js";
import noElseIfChainRule from "./rules/no-else-if-chain.js";
import noFallbackToEmptyRule from "./rules/no-fallback-to-empty.js";
import noHashLiteralRule from "./rules/no-hash-literal.js";
import noHostPathLiteralRule from "./rules/no-host-path-literal.js";
import packageMetadata from "../../package.json" with { type: "json" };

import { createSyntaxRules } from "../syntax-rules.mjs";
import ruleNoRawReactNativeTouchables from "./rules/no-raw-react-native-touchables.js";

const rules = {
  "no-dated-comments": noDatedCommentsRule,
  "no-else-if-chain": noElseIfChainRule,
  "no-fallback-to-empty": noFallbackToEmptyRule,
  "no-hash-literal": noHashLiteralRule,
  "no-host-path-literal": noHostPathLiteralRule,
  ...createSyntaxRules(),
  "no-raw-react-native-touchables": ruleNoRawReactNativeTouchables(),
};

export default {
  meta: {
    name: "@joedeleeuw/antidrift/oxlint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
