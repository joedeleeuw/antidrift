import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../../src/oxlint-plugin/index.js";

export function createPortableHarness(manifests) {
  const directory = mkdtempSync(join(tmpdir(), "antidrift-portable-"));
  for (const [file, manifest] of Object.entries(
    manifests ?? {
      "package.json": { name: "consumer", private: true },
      "apps/client/package.json": {
        name: "@consumer/client",
        dependencies: {
          "@homer/shared": "workspace:*",
          react: "catalog:",
          "react-native": "catalog:",
          zod: "catalog:",
        },
      },
      "apps/api/package.json": {
        name: "@consumer/api",
        dependencies: { zod: "catalog:" },
      },
      "apps/desktop/package.json": { name: "@consumer/desktop" },
      "apps/machine/package.json": { name: "@consumer/machine" },
      "apps/other/package.json": { name: "@consumer/other" },
      "packages/shared/package.json": {
        name: "@homer/shared",
        dependencies: { zod: "catalog:" },
      },
    },
  )) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(manifest));
  }
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n  - packages/*\ncatalog:\n  react: ^19\n  zod: ^3\n",
  );
  const linter = new Linter({ cwd: directory });
  return {
    directory,
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
    lint(name, code, filename = "component.tsx", options = {}) {
      return linter.verify(
        code,
        [
          {
            files: ["**/*.{ts,tsx,js,mjs}"],
            languageOptions: {
              parser,
              parserOptions: { ecmaFeatures: { jsx: true } },
            },
            plugins: { antidrift: plugin },
            rules: { [`antidrift/${name}`]: ["error", options] },
          },
        ],
        { filename: join(directory, filename) },
      );
    },
  };
}
