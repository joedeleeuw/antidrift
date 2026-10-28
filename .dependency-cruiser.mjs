import { createConfig } from "@joedeleeuw/typescript-tooling/dependency-cruiser";

const baseline = createConfig({ roots: "(apps|packages|tooling)" });

export default {
  ...baseline,
  options: {
    ...baseline.options,
    exclude: {
      ...baseline.options.exclude,
      path: [...baseline.options.exclude.path, "/fixtures/"],
    },
  },
};
