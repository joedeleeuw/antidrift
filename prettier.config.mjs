import tooling from "@joedeleeuw/typescript-tooling/prettier";

export default {
  ...tooling,
  overrides: [
    ...(tooling.overrides ?? []),
    { files: "*.mdc", options: { parser: "markdown" } },
  ],
};
