import { createConfig } from "@joedeleeuw/typescript-tooling/dependency-cruiser";

const baseline = createConfig({ roots: "(apps|packages|tooling)" });
const semanticAdapters = "^tooling/antidrift/src/semantic-adapters";
const layer = (name) => `${semanticAdapters}/${name}/`;
const ruleModules = [
  "^tooling/antidrift/src/eslint-plugin/",
  "^tooling/antidrift/src/oxlint-plugin/",
  "^tooling/antidrift/src/syntax-rules\\.mjs$",
  `${semanticAdapters}/syntax/`,
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
    layerRule(
      "projection-never-imports-boundary-or-callgraph",
      "projection",
      ["boundary", "callgraph"],
      "projection may only import kernel, provenance and shape"
    ),
    layerRule(
      "boundary-never-imports-callgraph",
      "boundary",
      ["callgraph"],
      "boundary may only import kernel, provenance, shape and projection"
    ),
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
