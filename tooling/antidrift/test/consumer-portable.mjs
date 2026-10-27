import { portableCases } from "./portable-cases.mjs";

export function provePortableRules({ file, lintOxlint, packedFiles }) {
  for (const required of [
    "package/NOTICE",
    "package/licenses/Apache-2.0.txt",
    "package/licenses/Rika-Labs-MIT.txt",
  ]) {
    if (!packedFiles.has(required)) {
      throw new Error(`Portable provenance missing from tarball: ${required}`);
    }
  }
  const overrides = [];
  for (const entry of portableCases) {
    const base = `portable-proofs/${entry.name}`;
    const filename = `${base}/${entry.filename ?? "component.tsx"}`;
    file(filename, entry.invalid);
    file(
      `${base}/package.json`,
      JSON.stringify({ name: "portable-proof", private: true })
    );
    file(
      `${base}/apps/client/package.json`,
      JSON.stringify({
        name: "@proof/client",
        dependencies: { "@homer/shared": "workspace:*" },
      })
    );
    file(
      `${base}/apps/other/package.json`,
      JSON.stringify({ name: "@proof/other" })
    );
    overrides.push({
      files: [filename],
      rules: {
        [`antidrift/${entry.name}`]: [
          "error",
          entry.name === "docs-source-policy"
            ? { ...entry.options, policyFile: filename }
            : (entry.options ?? {}),
        ],
      },
    });
    if (
      !packedFiles.has(
        `package/dist/${entry.artifact ?? `oxlint-plugin/portable/${entry.name}.js`}`
      )
    ) {
      throw new Error(`Portable rule missing from tarball: ${entry.name}`);
    }
  }
  file(
    "portable.config.json",
    JSON.stringify({
      categories: {
        correctness: "off",
        nursery: "off",
        pedantic: "off",
        perf: "off",
        restriction: "off",
        style: "off",
        suspicious: "off",
      },
      jsPlugins: [
        { name: "antidrift", specifier: "@joedeleeuw/antidrift/oxlint-plugin" },
      ],
      overrides,
    })
  );
  const output = lintOxlint("portable-proofs", "portable.config.json");
  const diagnostics = output.diagnostics ?? [];
  const expected = new Set(
    portableCases.map((entry) => `antidrift(${entry.name})`)
  );
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    if (!expected.has(diagnostic.code)) {
      throw new Error(
        `Unexpected portable consumer diagnostic: ${JSON.stringify(diagnostic)}`
      );
    }
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  for (const entry of portableCases) {
    const rule = `antidrift(${entry.name})`;
    const expectedCount = entry.occurrences ?? 1;
    if (counts.get(rule) !== expectedCount) {
      throw new Error(
        `Packed portable rule ${rule}: expected ${expectedCount} findings, got ${counts.get(rule) ?? 0}`
      );
    }
  }
  console.log(
    `     portable rules: ${expected.size} packed rules report their expected findings; licenses included`
  );
  proveDependencyResolution({ file, lintOxlint });
}

function proveDependencyResolution({ file, lintOxlint }) {
  const dependencyRoot = "portable-proofs/dependency-resolution";
  const sourceRoot = `${dependencyRoot}/apps/client/src`;
  const conditionalRoot = `${dependencyRoot}/apps/client/conditional`;
  const proofFiles = {
    "package.json": JSON.stringify({
      name: "dependency-resolution-proof",
      private: true,
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: {
          "@homer/shared/*": ["./shared/*"],
          "@portal/*": ["../portal/*"],
          "missing-alias/*": ["missing/*"],
          "utils/*": ["utils/*"],
        },
      },
    }),
    "apps/client/conditional/tsconfig.json": JSON.stringify({
      extends: "../../../tsconfig.json",
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
    }),
    "utils/logger.ts": 'export const logger = "logger";\n',
    "../portal/types/reports.ts": "export type Report = { id: string };\n",
    "shared/package.json": JSON.stringify({
      name: "@homer/shared",
      private: true,
    }),
    "shared/machine.ts": 'export const machine = "machine";\n',
    "apps/client/package.json": JSON.stringify({
      name: "@proof/client",
      type: "module",
      imports: {
        "#conditional": {
          import: "vitest",
          require: "./src/local.ts",
        },
        "#external": "vitest",
        "#local": "./src/local.ts",
        "#types-provider": "node",
      },
      devDependencies: {
        "@types/babel__core": "7.20.5",
        "@types/mdast": "4.0.4",
        "@types/node": "22.19.19",
      },
    }),
    "apps/client/src/local.ts": 'export const local = "local";\n',
    "apps/client/src/resolved.ts":
      'import { local } from "#local";\n' +
      'import type { Absent } from "#types-provider";\n' +
      'import type { Options } from "@babel/core";\n' +
      'import type { Report } from "@portal/types/reports";\n' +
      'import type { Root } from "mdast";\n' +
      'import { type RootContent } from "mdast";\n' +
      'import { logger } from "utils/logger";\n' +
      "export type Resolved = Absent | Options | Report | Root | RootContent;\n" +
      "export { local, logger };\n",
    "apps/client/src/runtime.ts":
      'import { parse } from "mdast";\n' +
      'import { missing } from "undeclared-package";\n' +
      "export { missing, parse };\n",
    "apps/client/src/sibling-package.ts":
      'import { machine } from "@homer/shared/machine";\nexport { machine };\n',
    "apps/client/src/package-import.ts":
      'import { expect } from "#external";\nexport { expect };\n',
    "apps/client/src/runtime-types-provider.ts":
      'import { absent } from "#types-provider";\n' +
      'export * from "#types-provider";\n' +
      "export { absent };\n",
    "apps/client/conditional/conditional.mts":
      'import { expect } from "#conditional";\n' +
      'const later = import("#conditional");\n' +
      "export { expect, later };\n",
    "apps/client/conditional/conditional.cts":
      'import { local } from "#conditional";\n' +
      'const later = import("#conditional");\n' +
      "export { local, later };\n",
    "apps/client/src/unlisted-type.ts":
      'import type { Missing } from "undeclared-types";\nexport type { Missing };\n',
    "apps/client/src/unresolved-alias.ts":
      'import { absent } from "missing-alias/file";\nexport { absent };\n',
  };
  for (const [filename, fileText] of Object.entries(proofFiles)) {
    file(`${dependencyRoot}/${filename}`, fileText);
  }
  file(
    "dependency-resolution.config.json",
    JSON.stringify({
      categories: {
        correctness: "off",
        nursery: "off",
        pedantic: "off",
        perf: "off",
        restriction: "off",
        style: "off",
        suspicious: "off",
      },
      jsPlugins: [
        { name: "antidrift", specifier: "@joedeleeuw/antidrift/oxlint-plugin" },
      ],
      overrides: [
        {
          files: [`${sourceRoot}/*.ts`],
          rules: { "antidrift/no-unlisted-external-imports": "error" },
        },
        {
          files: [
            `${sourceRoot}/package-import.ts`,
            `${sourceRoot}/runtime-types-provider.ts`,
            `${conditionalRoot}/conditional.mts`,
            `${conditionalRoot}/conditional.cts`,
          ],
          rules: {
            "antidrift/no-unlisted-external-imports": [
              "error",
              { ancestorDevDependencies: false },
            ],
          },
        },
      ],
    })
  );
  const output = lintOxlint(
    dependencyRoot,
    "dependency-resolution.config.json"
  );
  const dependencyDiagnostics = (output.diagnostics ?? [])
    .map(({ code, filename, message }) => ({ code, filename, message }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  const expectedDependencyDiagnostics = [
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${conditionalRoot}/conditional.cts`,
      message:
        "Declare 'vitest' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${conditionalRoot}/conditional.mts`,
      message:
        "Declare 'vitest' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${conditionalRoot}/conditional.mts`,
      message:
        "Declare 'vitest' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/runtime-types-provider.ts`,
      message:
        "Declare 'node' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/runtime-types-provider.ts`,
      message:
        "Declare 'node' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/package-import.ts`,
      message:
        "Declare 'vitest' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/runtime.ts`,
      message:
        "Declare 'mdast' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/runtime.ts`,
      message:
        "Declare 'undeclared-package' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/sibling-package.ts`,
      message:
        "Declare '@homer/shared' in the importing package's package.json; that package owns its dependency contract.",
    },
    {
      code: "antidrift(no-unlisted-external-imports)",
      filename: `${sourceRoot}/unlisted-type.ts`,
      message:
        "Declare 'undeclared-types' or its type provider in the importing package's package.json; that package owns its type dependency contract.",
    },
  ].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  if (
    JSON.stringify(dependencyDiagnostics) !==
    JSON.stringify(expectedDependencyDiagnostics)
  ) {
    throw new Error(
      `Dependency-resolution diagnostics differ: ${JSON.stringify({ dependencyDiagnostics, expectedDependencyDiagnostics })}`
    );
  }
  console.log(
    "     dependency ownership: TypeScript paths, package imports, and type providers resolve without hiding undeclared dependencies"
  );
}
