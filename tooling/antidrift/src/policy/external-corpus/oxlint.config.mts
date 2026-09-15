import { fileURLToPath } from "node:url";

import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    nursery: "error",
    pedantic: "error",
    perf: "error",
    restriction: "error",
    style: "error",
    suspicious: "error",
  },
  jsPlugins: [
    {
      name: "antidrift",
      specifier: fileURLToPath(
        new URL("../../oxlint-plugin/index.js", import.meta.url),
      ),
    },
  ],
  rules: {
    "antidrift/no-conditional-empty-object-spread": "error",
    "antidrift/no-module-mocking": "error",
    "antidrift/no-object-parameters": "error",
    "antidrift/no-reflect-apply": "error",
    "antidrift/no-reflect-get": "error",
    "antidrift/no-runtime-typeof": "error",
    "antidrift/no-service-constructor-imports": "error",
    "antidrift/no-shape-in-symbol-names": "error",
    "antidrift/no-unknown-parameters": "error",
    "antidrift/no-unknown-returns": "error",
    "antidrift/no-unknown-type-aliases": "error",
    "antidrift/no-unsafe-cast-chain": "error",
    "antidrift/no-unsafe-dictionary-type": "error",
    "antidrift/require-safety-comment-for-type-assertion": "error",
  },
});
