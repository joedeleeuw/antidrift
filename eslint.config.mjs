import { createConfig as antidrift } from "@joedeleeuw/antidrift/eslint-config";
import { createConfig as tooling } from "@joedeleeuw/typescript-tooling/eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  // Keep the repository's previous typed-source scope; .mts configs have
  // their own native compiler proof rather than project-service linting.
  ...tooling({ tsconfigRootDir: import.meta.dirname }).map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...antidrift({
    tsconfigRootDir: import.meta.dirname,
    projectService: {
      allowDefaultProject: ["*.ts", "apps/*/vite.config.ts"],
      defaultProject: "./tsconfig.base.json",
    },
  }),
  {
    files: ["tooling/antidrift/src/**/*.ts"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 20],
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-duplicated-branches": "error",
    },
  },
  { ignores: ["tooling/antidrift/src/**/fixtures/**"] },
];
