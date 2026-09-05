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

const require = createRequire(import.meta.url);
const oxlint = join(
  dirname(require.resolve("oxlint/package.json")),
  "bin/oxlint",
);
const repository = process.argv[2];
if (!repository) throw new Error("Pass the read-only Homer checkout path.");
const scratch = mkdtempSync(join(tmpdir(), "antidrift-homer-reproduction-"));
const checkout = join(scratch, "checkout");
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
try {
  mkdirSync(checkout);
  const archive = execFileSync(
    "git",
    ["-C", repository, "archive", review.revision],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  const archiveFile = join(scratch, "source.tar");
  writeFileSync(archiveFile, archive);
  execFileSync("tar", ["-xf", archiveFile, "-C", checkout]);
  const directories = [checkout];
  while (directories.length) {
    const directory = directories.pop();
    const installed = join(
      repository,
      relative(checkout, directory),
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
  const rows = [];
  for (const entry of portableCases) {
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
    const expected = review.rules.find(
      (rule) => rule.rule === entry.name,
    ).after;
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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
