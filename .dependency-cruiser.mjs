import { createConfig } from "@joedeleeuw/typescript-tooling/dependency-cruiser";

const baseline = createConfig({ roots: "(apps|packages|tooling)" });
const semanticAdapters = "^tooling/antidrift/src/semantic-adapters";
const layer = (name) => `${semanticAdapters}/${name}/`;
const ruleModules = [
  "^tooling/antidrift/src/eslint-plugin/",
  "^tooling/antidrift/src/oxlint-plugin/",
  "^tooling/antidrift/src/syntax-rules\\.mjs$",
  `${semanticAdapters}/local-ast-rules\\.`,
];
const layerRule = (name, from, forbiddenLayers, comment) => ({
  name,
  comment,
  severity: "error",
  from: { path: layer(from) },
  to: { path: `${semanticAdapters}/(${forbiddenLayers.join("|")})/` },
});

export default {
  ...baseline,
  forbidden: [
    ...baseline.forbidden,
    layerRule(
      "kernel-is-the-lowest-layer",
      "kernel",
      ["provenance", "shape", "projection", "boundary", "callgraph"],
      "kernel is the lowest semantic layer and must not import higher layers"
    ),
    layerRule(
      "provenance-imports-only-kernel",
      "provenance",
      ["shape", "projection", "boundary", "callgraph"],
      "provenance may only import kernel"
    ),
    layerRule(
      "shape-imports-only-kernel-and-provenance",
      "shape",
      ["projection", "boundary", "callgraph"],
      "shape may only import kernel and provenance"
    ),
    {
      name: "domain-layers-are-siblings",
      comment:
        "projection, boundary, and callgraph are sibling domain layers and must not import each other",
      severity: "error",
      from: { path: `${semanticAdapters}/(projection|boundary|callgraph)/` },
      to: {
        path: `${semanticAdapters}/(projection|boundary|callgraph)/`,
        pathNot: `${semanticAdapters}/$1/`,
      },
    },
    {
      name: "primitives-never-import-rules",
      comment:
        "semantic primitives must not import rule modules; share logic through the primitive layers",
      severity: "error",
      from: {
        path: `${semanticAdapters}/(kernel|provenance|shape|projection|boundary|callgraph)/`,
      },
      to: { path: ruleModules },
    },
  ],
  options: {
    ...baseline.options,
    exclude: {
      ...baseline.options.exclude,
      path: [...baseline.options.exclude.path, "/fixtures/"],
    },
  },
};
