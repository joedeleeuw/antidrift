import packageMetadata from "../../package.json" with { type: "json" };

import { createSyntaxRules } from "../syntax-rules.mjs";

const rules = createSyntaxRules();

export default {
  meta: {
    name: "@joedeleeuw/antidrift/oxlint-plugin",
    version: packageMetadata.version,
  },
  rules,
};
