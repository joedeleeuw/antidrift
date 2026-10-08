import { createConfig as antidrift } from "@joedeleeuw/antidrift/eslint-config";
import { createConfig as tooling } from "@joedeleeuw/typescript-tooling/eslint";

export default [
  // Keep the repository's previous typed-source scope; .mts configs have
  // their own native compiler proof rather than project-service linting.
  ...tooling({ tsconfigRootDir: import.meta.dirname }).map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...antidrift({ tsconfigRootDir: import.meta.dirname }),
];
