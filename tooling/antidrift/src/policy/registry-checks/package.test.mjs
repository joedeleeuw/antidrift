import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkRegistries } from "../check-registries.mjs";
import { SEMANTIC_ADAPTER_CONTRACTS } from "../../semantic-adapters/index.mjs";
import {
  semanticAdapterPackageExports,
  touch,
  touchSemanticAdapterPackageExportFiles,
  workspace,
  writePackageJson,
  writeValidRulesRegistry,
} from "../../../test/support/registry-workspace.mjs";

describe("package surface", () => {
  it("rejects shipped semantic adapters missing package export subpaths", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        "./semantic-adapters": {
          types: "./src/semantic-adapters/index.d.mts",
          import: "./src/semantic-adapters/index.mjs",
        },
        "./semantic-adapters/auth-boundary": {
          types: "./src/semantic-adapters/auth-boundary.d.mts",
          import: "./src/semantic-adapters/auth-boundary.mjs",
        },
        "./semantic-adapters/broad-input": {
          types: "./src/semantic-adapters/broad-input.d.mts",
          import: "./src/semantic-adapters/broad-input.mjs",
        },
        "./semantic-adapters/react-state": {
          types: "./src/semantic-adapters/react-state.d.mts",
          import: "./src/semantic-adapters/react-state.mjs",
        },
        "./semantic-adapters/schema-provenance": {
          types: "./src/semantic-adapters/schema-provenance.d.mts",
          import: "./src/semantic-adapters/schema-provenance.mjs",
        },
        "./semantic-adapters/sql": {
          types: "./src/semantic-adapters/sql.d.mts",
          import: "./src/semantic-adapters/sql.mjs",
        },
        "./semantic-adapters/type-owner": {
          types: "./src/semantic-adapters/type-owner.d.mts",
          import: "./src/semantic-adapters/type-owner.mjs",
        },
      },
    });
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports missing semantic adapter subpath: ./semantic-adapters/parse-input",
    );
  });
  it("rejects shipped semantic adapter package exports whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touch(root, "tooling/antidrift/src/semantic-adapters/index.d.mts");
    touch(root, "tooling/antidrift/src/semantic-adapters/index.mjs");
    for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
      if (contract.id === "parse-input") {
        continue;
      }
      touch(
        root,
        `tooling/antidrift/src/semantic-adapters/${contract.id}.d.mts`,
      );
      touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.mjs`);
    }
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.import path does not exist: ./src/semantic-adapters/parse-input.mjs",
    );
  });
  it("rejects semantic adapter runtime exports missing type declarations", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.mjs",
      ),
      "export function runtimeOnly() {}\n",
    );
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.d.mts",
      ),
      "export function declaredOnly(): void;\n",
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.import runtime export runtimeOnly is missing from types path ./src/semantic-adapters/parse-input.d.mts",
    );
  });
  it("rejects semantic adapter type declarations missing runtime exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.mjs",
      ),
      "export function runtimeOnly() {}\n",
    );
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.d.mts",
      ),
      [
        "export function runtimeOnly(): void;",
        "export function declaredOnly(): void;",
        "export interface TypeOnlyDeclaration {}",
        "",
      ].join("\n"),
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.types declaration declaredOnly is missing from runtime import path ./src/semantic-adapters/parse-input.mjs",
    );
    expect(messages.join("\n")).not.toContain("TypeOnlyDeclaration");
  });
  it("rejects non-adapter package exports whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        ...semanticAdapterPackageExports(),
        "./policy": {
          types: "./src/policy/index.d.mts",
          import: "./src/policy/missing.mjs",
        },
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    touch(root, "tooling/antidrift/src/policy/index.d.mts");
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./policy.import path does not exist: ./src/policy/missing.mjs",
    );
  });
  it("rejects non-adapter default type declarations missing runtime exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        ...semanticAdapterPackageExports(),
        "./eslint-plugin": {
          types: "./src/eslint-plugin/index.d.ts",
          import: "./src/eslint-plugin/index.js",
        },
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    mkdirSync(join(root, "tooling", "antidrift", "src", "eslint-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "eslint-plugin", "index.js"),
      "export const plugin = {};\n",
    );
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "eslint-plugin", "index.d.ts"),
      "declare const plugin: unknown;\nexport default plugin;\n",
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./eslint-plugin.types declaration default is missing from runtime import path ./src/eslint-plugin/index.js",
    );
  });
  it("rejects package CLI binary targets whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: semanticAdapterPackageExports(),
      bin: {
        antidrift: "src/policy/missing-cli.mjs",
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json bin.antidrift path does not exist: src/policy/missing-cli.mjs",
    );
  });
  it("rejects package CLI binary targets without a Node shebang", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: semanticAdapterPackageExports(),
      bin: {
        antidrift: "src/policy/cli.mjs",
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    mkdirSync(join(root, "tooling", "antidrift", "src", "policy"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "policy", "cli.mjs"),
      "console.log('not a direct cli');\n",
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json bin.antidrift must start with #!/usr/bin/env node.",
    );
  });
  it("requires the package README public entry points to mention shipped exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      name: "@joedeleeuw/antidrift",
      exports: semanticAdapterPackageExports(),
    });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(root, "tooling", "antidrift", "README.md"),
      Object.keys(semanticAdapterPackageExports())
        .filter((exportKey) => exportKey !== "./semantic-adapters/parse-input")
        .map((exportKey) =>
          exportKey === "."
            ? "- `@joedeleeuw/antidrift`"
            : `- \`@joedeleeuw/antidrift/${exportKey.slice(2)}\``,
        )
        .join("\n"),
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/README.md public entry points missing package export: @joedeleeuw/antidrift/semantic-adapters/parse-input",
    );
  });
  it("rejects stale package README public entry points that are not shipped exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      name: "@joedeleeuw/antidrift",
      exports: semanticAdapterPackageExports(),
    });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(root, "tooling", "antidrift", "README.md"),
      [
        ...Object.keys(semanticAdapterPackageExports()).map((exportKey) =>
          exportKey === "."
            ? "- `@joedeleeuw/antidrift`"
            : `- \`@joedeleeuw/antidrift/${exportKey.slice(2)}\``,
        ),
        "- `@joedeleeuw/antidrift/semantic-adapters/not-real`",
      ].join("\n"),
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/README.md public entry points lists non-exported package specifier: @joedeleeuw/antidrift/semantic-adapters/not-real",
    );
  });
});
