export const evidenceCases = [
  {
    id: "sudocode-spec-kit-deps-undeclared-copilotkit",
    repo: "sudocode-main",
    sha: "cf3d9ccf",
    kind: "gold-tp",
    subject: "add spec-kit deps",
    contract: contract({
      allowedPaths: [
        ".sudocode/issues.jsonl",
        ".sudocode/specs.jsonl",
        "frontend/package.json",
        "package-lock.json",
      ],
      checkedSurfaces: ["paths", "changeTypes", "dependencies"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["undeclared-runtime-dependency"],
      dependencies: [
        "@copilotkit/react-core",
        "@copilotkit/react-ui",
        "@copilotkit/runtime",
      ],
    },
  },
  {
    id: "sudocode-claude-md-submodule-removal",
    repo: "sudocode-main",
    sha: "6c7c672",
    kind: "gold-tp",
    subject: "update claude.md",
    contract: contract({
      allowedPaths: [".claude/CLAUDE.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: [".gitmodules", "references/beads"],
    },
  },
  {
    id: "sudocode-version-bump-submodule-additions",
    repo: "sudocode-main",
    sha: "c2fcd1d",
    kind: "gold-tp",
    subject:
      "update version incrementing script and upgrade minor version for test release",
    contract: contract({
      allowedPaths: [
        "**/package.json",
        "**/package-lock.json",
        "scripts/version.sh",
      ],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: [
        ".gitmodules",
        "references/CodeMachine-CLI",
        "references/agentapi",
        "references/beads",
        "references/claude-flow",
        "references/vibe-kanban",
      ],
    },
  },
  {
    id: "sudocode-skill-content-submodule-additions",
    repo: "sudocode-main",
    sha: "f722716",
    kind: "gold-tp",
    subject: "update skill content to show preference for direct md changes",
    contract: contract({
      allowedPaths: ["skills/sudocode/SKILL.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: ["references/toad", "references/vibe-kanban"],
    },
  },
  {
    id: "chaski-missing-estimation-sentry-session-sprawl",
    repo: "chaski",
    sha: "7f871d2",
    kind: "gold-tp",
    subject: "fix(app): let missing-estimation items reach zero [GE-1147]",
    contract: contract({
      allowedPaths: ["app/lib/src/core/pricing/**", "app/test/core/pricing/**"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["add", "modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: [
        "app/lib/main.dart",
        "app/lib/src/core/services/app_environment_reporter.dart",
        "app/lib/src/core/services/session_manager.dart",
        "app/lib/src/ui/mixins/promotion_task_modals.dart",
      ],
    },
  },
  {
    id: "sudocode-readme-plugin-install-clean",
    repo: "sudocode-main",
    sha: "52dec81e",
    kind: "true-negative",
    subject: "Clarify plugin installation instructions in README (#152)",
    contract: contract({
      allowedPaths: ["README.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "sudocode-js-yaml-dependency-clean",
    repo: "sudocode-main",
    sha: "d0ea172b",
    kind: "true-negative",
    subject: "[Workflow 1/6] i-7v2c: Add js-yaml dependency to cli package",
    contract: contract({
      allowedPaths: [
        ".sudocode/issues.jsonl",
        "cli/package.json",
        "package-lock.json",
      ],
      checkedSurfaces: ["paths", "changeTypes", "dependencies"],
      allowedChangeTypes: ["modify"],
      allowedRuntimeDependencies: ["js-yaml"],
      allowedDevDependencies: ["@types/js-yaml"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "sudocode-yaml-converter-clean",
    repo: "sudocode-main",
    sha: "0402e9eb",
    kind: "true-negative",
    subject:
      "[Workflow 2/9] i-9afp: Implement YAML Converter with Multi-Line Support",
    contract: contract({
      allowedPaths: [
        "cli/src/yaml-converter.ts",
        "cli/tests/unit/yaml-converter.test.ts",
      ],
      checkedSurfaces: ["paths", "changeTypes", "exports"],
      allowedChangeTypes: ["add"],
      allowedExports: [
        {
          file: "cli/src/yaml-converter.ts",
          name: "YamlConverterOptions",
          kind: "type",
        },
        { file: "cli/src/yaml-converter.ts", name: "fromYaml", kind: "value" },
        {
          file: "cli/src/yaml-converter.ts",
          name: "fromYamlDocuments",
          kind: "value",
        },
        { file: "cli/src/yaml-converter.ts", name: "toYaml", kind: "value" },
        {
          file: "cli/src/yaml-converter.ts",
          name: "toYamlDocuments",
          kind: "value",
        },
        {
          file: "cli/src/yaml-converter.ts",
          name: "verifyRoundTrip",
          kind: "value",
        },
      ],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "chaski-crow-prettier-autofix-clean",
    repo: "chaski",
    sha: "b5e18da03",
    kind: "true-negative",
    subject:
      "chore: dedupe native eslint ignores, apply crow-v2 prettier autofix (#5689)",
    contract: contract({
      allowedPaths: ["src/**", "app/**", "packages/**", "eslint.config.*"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "chaski-erp-proto-docs-generated-clean",
    repo: "chaski",
    sha: "d6c56c0d5",
    kind: "true-negative",
    subject:
      "docs(erp-integration): document Driver and publishing-store routing",
    contract: contract({
      allowedPaths: [
        "src/backend/erp-integration/**",
        "app/lib/gen/src/backend/erp-integration/**",
        "gen/go/**",
        "gen/py/**",
        "src/frontend/bff/gen/ts/**",
      ],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "chaski-mock-erp-removal-clean",
    repo: "chaski",
    sha: "59e1bee78",
    kind: "true-negative",
    subject: "chore(mocks) remove mocks (#5605)",
    contract: contract({
      allowedPaths: ["infra/k8s/**", "src/mocks/**", "scripts/runall/BUILD"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["delete", "modify"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "chaski-architecture-diagrams-clean",
    repo: "chaski",
    sha: "9da69cc59",
    kind: "true-negative",
    subject: "chore(docs): add engineering architecture diagrams",
    contract: contract({
      allowedPaths: ["docs/**/*.excalidraw.json"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["add"],
    }),
    expected: { violationTypes: [] },
  },
];

function contract({
  allowedPaths,
  checkedSurfaces,
  allowedChangeTypes,
  allowedRuntimeDependencies = [],
  allowedDevDependencies = [],
  allowedExports = [],
}) {
  return {
    schemaVersion: 1,
    scope: {
      allowedPaths,
      checkedSurfaces,
      allowedChangeTypes,
      allowedRuntimeDependencies,
      allowedDevDependencies,
      allowedExports,
    },
  };
}
