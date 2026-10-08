import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGovernanceOxlintConfig } from "./index.mjs";

describe("createGovernanceOxlintConfig", () => {
  it("derives restricted imports and gateway exemptions from registries", () => {
    const config = createGovernanceOxlintConfig({
      repoRoot: process.cwd(),
    });
    const [, restrictedImports] = config.rules["no-restricted-imports"];
    const restrictedGroups = restrictedImports.patterns.flatMap(
      ({ group }) => group
    );

    expect(restrictedGroups).toEqual(
      expect.arrayContaining([
        "openai",
        "@anthropic-ai/sdk",
        "stripe",
        "@aws-sdk/**",
        "@google-cloud/**",
      ])
    );
    expect(config.overrides).toEqual(
      expect.arrayContaining([
        {
          files: ["packages/gateways/src/aiGateway.ts"],
          rules: { "no-restricted-imports": "off" },
        },
      ])
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
        ].join("\n")
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
        ])
      );
      expect(config.ignorePatterns).not.toEqual(
        expect.arrayContaining([
          "**/_generated/**",
          "**/generated/**",
          "**/*.gen.*",
          "**/*.generated.*",
        ])
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
        ].join("\n")
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository })
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.escaped.generated must be a relative repo path below the repository root."
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
          "\n"
        )
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository })
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.widened.generated must be an exact repo path without glob metacharacters."
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
        registryLines.join("\n")
      );

      expect(() =>
        createGovernanceOxlintConfig({ repoRoot: repository })
      ).toThrow(
        "policy/registries/generated.yaml generatedSources.invalid.generated must be a non-empty string."
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
