import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  antidriftComplexityRules,
  createGovernanceOxlintConfig,
} from "./index.mjs";

function severity(ruleValue) {
  return Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
}

describe("createGovernanceOxlintConfig", () => {
  it("owns governance plus the TypeScript baseline, without style baselines", () => {
    const config = createGovernanceOxlintConfig({
      repoRoot: process.cwd(),
    });

    expect(config.categories).toEqual({
      correctness: "off",
      nursery: "off",
      pedantic: "off",
      perf: "off",
      restriction: "off",
      style: "off",
      suspicious: "off",
    });
    expect(config.options.typeAware).toBeUndefined();
    expect(config.plugins).toEqual(["eslint", "typescript"]);
    expect(config.jsPlugins.map(({ name }) => name)).toEqual([
      "antidrift",
      "eslint-comments",
    ]);
    expect(severity(config.rules["max-lines"])).toBe("error");
    expect(severity(config.rules["eslint-comments/disable-enable-pair"])).toBe(
      "error",
    );
    expect(severity(config.rules["antidrift/require-effect-deps"])).toBe(
      "error",
    );
    expect(config.rules["antidrift/no-runtime-typeof"]).toBe("off");
    expect(config.rules["antidrift/no-conditional-empty-object-spread"]).toBe(
      "off",
    );
    expect(config.rules["antidrift/no-module-mocking"]).toBe("off");
    expect(config.rules["antidrift/no-object-parameters"]).toBe("off");
    expect(config.rules["antidrift/no-reflect-apply"]).toBe("off");
    expect(config.rules["antidrift/no-reflect-get"]).toBe("off");
    expect(config.rules["antidrift/no-service-constructor-imports"]).toBe(
      "off",
    );
    expect(config.rules["antidrift/no-shape-in-symbol-names"]).toBe("off");
    expect(config.rules["antidrift/no-unknown-parameters"]).toBe("off");
    expect(config.rules["antidrift/no-unknown-returns"]).toBe("off");
    expect(config.rules["antidrift/no-unsafe-dictionary-type"]).toBe("off");
    expect(config.rules["antidrift/no-unknown-type-aliases"]).toBe("error");
    expect(config.rules["antidrift/no-unsafe-cast-chain"]).toBe("error");
    expect(
      config.rules["antidrift/require-safety-comment-for-type-assertion"],
    ).toBe("off");
    expect(config.rules.complexity).toBeUndefined();
    expect(config.rules["max-depth"]).toBeUndefined();
    expect(config.rules["max-params"]).toBeUndefined();
    expect(config.rules["react/react-compiler"]).toBeUndefined();
    expect(severity(config.rules["typescript/no-explicit-any"])).toBe("error");
    expect(severity(config.rules["typescript/no-misused-promises"])).toBe(
      "error",
    );
    expect(config.rules["vitest/no-focused-tests"]).toBeUndefined();
    expect(config.rules["unicorn/no-abusive-eslint-disable"]).toBeUndefined();
    expect(config.rules["import/no-cycle"]).toBeUndefined();
    expect(config.rules["boundaries/element-types"]).toBeUndefined();
    expect(config.settings).toBeUndefined();
  });

  it("derives restricted imports and gateway exemptions from registries", () => {
    const config = createGovernanceOxlintConfig({
      repoRoot: process.cwd(),
    });
    const [, restrictedImports] = config.rules["no-restricted-imports"];
    const restrictedGroups = restrictedImports.patterns.flatMap(
      ({ group }) => group,
    );

    expect(restrictedGroups).toEqual(
      expect.arrayContaining([
        "openai",
        "@anthropic-ai/sdk",
        "stripe",
        "@aws-sdk/**",
        "@google-cloud/**",
      ]),
    );
    expect(config.overrides).toEqual(
      expect.arrayContaining([
        {
          files: ["packages/gateways/src/aiGateway.ts"],
          rules: { "no-restricted-imports": "off" },
        },
      ]),
    );
  });

  it("ignores only registry-declared generated files and directories", () => {
    const repository = mkdtempSync(join(tmpdir(), "antidrift-oxlint-config-"));

    try {
      const registryDirectory = join(repository, "policy", "registries");
      mkdirSync(join(repository, "convex", "_generated"), { recursive: true });
      mkdirSync(join(repository, "src"), { recursive: true });
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(join(repository, "src", "routeTree.gen.ts"), "");
      writeFileSync(
        join(registryDirectory, "generated.yaml"),
        [
          "generatedSources:",
          "  routeTree:",
          "    generated: src/routeTree.gen.ts",
          "  convex:",
          "    generated: convex/_generated",
          "",
        ].join("\n"),
      );

      const config = createGovernanceOxlintConfig({
        repoRoot: repository,
      });

      expect(config.ignorePatterns).toEqual(
        expect.arrayContaining([
          "src/routeTree.gen.ts",
          "src/routeTree.gen.ts/**",
          "convex/_generated",
          "convex/_generated/**",
        ]),
      );
      expect(config.ignorePatterns).not.toEqual(
        expect.arrayContaining([
          "**/_generated/**",
          "**/generated/**",
          "**/*.gen.*",
          "**/*.generated.*",
        ]),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("rejects a generated path outside the repository", () => {
    const repository = mkdtempSync(join(tmpdir(), "antidrift-oxlint-config-"));

    try {
      const registryDirectory = join(repository, "policy", "registries");
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(
        join(registryDirectory, "generated.yaml"),
        [
          "generatedSources:",
          "  escaped:",
          "    generated: ../outside",
          "",
        ].join("\n"),
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository }),
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.escaped.generated must be a relative repo path below the repository root.",
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("rejects generated path globs before they can widen ignore scope", () => {
    const repository = mkdtempSync(join(tmpdir(), "antidrift-oxlint-config-"));

    try {
      const registryDirectory = join(repository, "policy", "registries");
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(
        join(registryDirectory, "generated.yaml"),
        ["generatedSources:", "  widened:", '    generated: "src/**"', ""].join(
          "\n",
        ),
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository }),
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.widened.generated must be an exact repo path without glob metacharacters.",
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", ["generatedSources:", "  invalid: {}", ""]],
    ["empty", ["generatedSources:", "  invalid:", '    generated: ""', ""]],
  ])("rejects a %s generated path", (_case, registryLines) => {
    const repository = mkdtempSync(join(tmpdir(), "antidrift-oxlint-config-"));

    try {
      const registryDirectory = join(repository, "policy", "registries");
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(
        join(registryDirectory, "generated.yaml"),
        registryLines.join("\n"),
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository }),
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.invalid.generated must be a non-empty string.",
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("exports immutable complexity thresholds for explicit consumer scopes", () => {
    expect(antidriftComplexityRules).toEqual({
      complexity: ["error", { max: 25, variant: "modified" }],
      "max-depth": ["error", 4],
      "max-params": ["error", { max: 7 }],
    });
    expect(Object.isFrozen(antidriftComplexityRules)).toBe(true);
    expect(Object.isFrozen(antidriftComplexityRules.complexity)).toBe(true);
    expect(Object.isFrozen(antidriftComplexityRules.complexity[1])).toBe(true);
    expect(Object.isFrozen(antidriftComplexityRules["max-depth"])).toBe(true);
    expect(Object.isFrozen(antidriftComplexityRules["max-params"])).toBe(true);
    expect(Object.isFrozen(antidriftComplexityRules["max-params"][1])).toBe(
      true,
    );
  });
});
