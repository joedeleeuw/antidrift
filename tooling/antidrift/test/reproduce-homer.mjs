import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import { createRequire } from "node:module";
import review from "./corpus/homer-review.json" with { type: "json" };
import { portableCases } from "./portable-cases.mjs";
import {
  createAdoptionOxlintConfig,
  antidriftAdoptionPresets,
} from "../src/oxlint-config/adoption.mjs";
import { proveHomerJson } from "./reproduce-homer-json.mjs";
import selection from "./corpus/native-selection.json" with { type: "json" };
import { lintTypedArtifact } from "./typed-artifact.mjs";

const require = createRequire(import.meta.url);
const oxlint = join(
  dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);
const repository = process.argv[2];
if (!repository) throw new Error("Pass the read-only Homer checkout path.");
if (process.argv[3] && process.argv[3] !== "--owned-projections-only") {
  throw new Error(
    "Only the optional --owned-projections-only slice is supported.",
  );
}
const scratch = mkdtempSync(join(tmpdir(), "antidrift-homer-reproduction-"));
const paths = [
  "apps/api",
  "apps/client",
  "apps/desktop",
  "apps/machine",
  "packages",
  "infra",
  "scripts",
];
const ignorePatterns = review.ignorePatterns;
function archiveCheckout(revision) {
  const destination = join(scratch, revision);
  mkdirSync(destination);
  const archive = execFileSync("git", ["-C", repository, "archive", revision], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const archiveFile = join(scratch, "source.tar");
  writeFileSync(archiveFile, archive);
  execFileSync("tar", ["-xf", archiveFile, "-C", destination]);
  const directories = [destination];
  while (directories.length) {
    const directory = directories.pop();
    const installed = join(
      repository,
      relative(destination, directory),
      "node_modules",
    );
    if (existsSync(installed)) {
      symlinkSync(installed, join(directory, "node_modules"), "dir");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        directories.push(join(directory, entry.name));
      }
    }
  }
  return destination;
}

try {
  const ownedProjections = [];
  for (const [revision, expected] of [
    ["46ca37f8d690eb6101dbbdad3dd6309375d65306", 1],
    ["745c8c59af435a9ae08a1ca9d53983dda8e2c3f3", 0],
  ]) {
    const { messages, sourceFiles } = lintTypedArtifact({
      checkout: archiveCheckout(revision),
      project: "apps/client/tsconfig.json",
      file: "apps/client/src/screens/machine/conversation-feed-row.tsx",
      rules: {
        "antidrift/no-structural-type-fork": "error",
        "antidrift/no-canonical-model-fork": "error",
      },
    });
    assert.equal(
      messages.length,
      expected,
      `${revision}: expected ${expected} owned projections, received ${JSON.stringify(messages)}`,
    );
    if (expected) {
      assert.equal(messages[0].ruleId, "antidrift/no-structural-type-fork");
      assert.equal(messages[0].severity, 2);
      assert.equal(messages[0].line, 43);
      assert.match(
        messages[0].message,
        /Contract copies .*FunctionArgs<typeof api\.conversations\.listHistory>\["scope"\]/u,
      );
    }
    ownedProjections.push({
      revision,
      findings: messages.length,
      sourceFiles,
      messages,
    });
  }
  console.log(JSON.stringify({ ownedProjections }, null, 2));
  if (process.argv[3] !== "--owned-projections-only") {
    const checkout = archiveCheckout(review.revision);
    const rows = [];
    const unreviewedCustom = [];
    for (const entry of portableCases) {
      const reviewed = review.rules.find((rule) => rule.rule === entry.name);
      if (!reviewed) {
        unreviewedCustom.push(entry.name);
        continue;
      }
      const config = {
        categories: Object.fromEntries(
          [
            "correctness",
            "nursery",
            "pedantic",
            "perf",
            "restriction",
            "style",
            "suspicious",
          ].map((name) => [name, "off"]),
        ),
        ignorePatterns,
        jsPlugins: [
          {
            name: "antidrift",
            specifier: resolve(
              import.meta.dirname,
              "../src/oxlint-plugin/index.js",
            ),
          },
        ],
        rules: {
          [`antidrift/${entry.name}`]: [
            "error",
            review.configurations[entry.name],
          ],
        },
      };
      const configFile = join(scratch, "rule.json");
      writeFileSync(configFile, JSON.stringify(config));
      const run = spawnSync(
        process.execPath,
        [
          oxlint,
          "-c",
          configFile,
          "--disable-nested-config",
          "--threads",
          "2",
          "--format",
          "json",
          ...paths,
        ],
        { cwd: checkout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      if (run.error) throw run.error;
      if (![0, 1].includes(run.status)) throw new Error(run.stderr);
      const diagnostics = JSON.parse(run.stdout).diagnostics;
      const expected = reviewed.after;
      if (diagnostics.length !== expected) {
        throw new Error(
          `${entry.name}: expected ${expected}, received ${diagnostics.length}`,
        );
      }
      rows.push({
        rule: entry.name,
        findings: diagnostics.length,
        lintExitCode: run.status,
      });
    }
    const config = createAdoptionOxlintConfig({
      presets: Object.keys(antidriftAdoptionPresets),
    });
    if (Object.keys(config.rules).length !== selection.rules.length) {
      throw new Error("Native selection differs from the reviewed inventory.");
    }
    config.ignorePatterns = ignorePatterns;
    const configFile = join(scratch, "native.json");
    writeFileSync(configFile, JSON.stringify(config));
    const native = spawnSync(
      process.execPath,
      [
        oxlint,
        "-c",
        configFile,
        "--disable-nested-config",
        "--threads",
        "2",
        "--format",
        "json",
        ...paths,
      ],
      { cwd: checkout, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    );
    if (native.error) throw native.error;
    if (![0, 1].includes(native.status)) throw new Error(native.stderr);
    const json = proveHomerJson(checkout);
    console.log(
      JSON.stringify(
        {
          json,
          revision: review.revision,
          custom: rows,
          unreviewedCustom,
          native: {
            rules: selection.rules.length,
            findings: JSON.parse(native.stdout).diagnostics.length,
            lintExitCode: native.status,
          },
        },
        null,
        2,
      ),
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
