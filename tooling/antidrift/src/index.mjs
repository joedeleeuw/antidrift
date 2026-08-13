export { createConfig } from "./eslint-config/index.mjs";
export { default as eslintPlugin } from "./eslint-plugin/index.js";
export {
  antidriftComplexityRules,
  createGovernanceOxlintConfig,
} from "./oxlint-config/index.mjs";
export { default as oxlintPlugin } from "./oxlint-plugin/index.js";
// Oxlint's jsPlugins loader reads the default export of whatever specifier
// it is given. Without this alias, `specifier: "@joedeleeuw/antidrift"`
// crashes with an undefined-destructure instead of registering the plugin.
export { default } from "./oxlint-plugin/index.js";
export {
  loadPolicy,
  renderPolicyArtifacts,
} from "./policy/generate-policy-artifacts.mjs";
export { loadRegistriesSync } from "./policy/lib/registries.mjs";
