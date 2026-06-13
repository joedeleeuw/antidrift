export { createConfig } from "./eslint-config/index.mjs";
export type { AntidriftConfigOptions } from "./eslint-config/index.mjs";
export { default as eslintPlugin } from "./eslint-plugin/index.js";
export {
  loadPolicy,
  loadRegistriesSync,
  renderPolicyArtifacts,
} from "./policy/index.mjs";
export type {
  AgentGuardrailsPolicy,
  AntidriftRegistries,
  PolicyArtifacts,
  PolicyCluster,
  PolicyRule,
} from "./policy/index.mjs";
