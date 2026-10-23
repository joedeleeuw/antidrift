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
        new URL("../../../src/oxlint-plugin/index.js", import.meta.url)
      ),
    },
  ],
  rules: {
    "antidrift/no-unknown-type-aliases": "error",
    "antidrift/no-unsafe-cast-chain": "error",
  },
});
