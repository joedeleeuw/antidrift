import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseNameStatusRecords } from "../src/change-scope/change-context.mjs";

const PLANTED_DERIVE_VIOLATIONS = {
  "src/methods/callbacky.ts":
    'import type { Session } from "../shared/session";\n\nexport async function callbacky(input: { label: string; onDone: () => void }, session: Session): Promise<string> {\n  input.onDone();\n  return Promise.resolve(session.userId);\n}\n',
  "src/methods/renamed.ts":
    'export async function somethingElse(): Promise<string> {\n  return Promise.resolve("renamed");\n}\n',
  "src/methods/syncMethod.ts":
    "export function syncMethod(label: string): string {\n  return label.toUpperCase();\n}\n",
  "src/methods/voidResult.ts":
    "export async function voidResult(): Promise<void> {\n  await Promise.resolve();\n}\n",
  "src/methods/optionalArg.ts":
    "export async function optionalArg(todoId: string, note?: string): Promise<string> {\n  return Promise.resolve(note ?? todoId);\n}\n",
  "src/routes/lists/route.ts":
    "export function GET(): Response {\n  return Response.json([]);\n}\n",
  "src/shared/asyncShared.ts":
    "export async function asyncShared(): Promise<number> {\n  return Promise.resolve(1);\n}\nexport const asyncSharedArrow = async (): Promise<number> => Promise.resolve(2);\n",
  "src/methods/surrogateKey.ts":
    'export async function surrogateKey(input: { "x\\uD83D": string }): Promise<string> {\n  return Promise.resolve(input["x\\uD83D"]);\n}\n',
  "src/methods/surrogateLiteral.ts":
    'export async function surrogateLiteral(): Promise<"\\uD83D"> {\n  return "\\uD83D";\n}\n',
  "src/methods/overlap.ts":
    "export async function overlap(id: string): Promise<{ id: string } | { id: string; detail: number }> {\n  return Promise.resolve({ id, detail: 7 });\n}\n",
  "src/methods/arrayOverlap.ts":
    'export async function arrayOverlap(): Promise<{ id: string }[] | { id: string; detail: number }[]> {\n  return Promise.resolve([{ id: "x", detail: 7 }]);\n}\n',
  "src/methods/primitiveArrayOverlap.ts":
    "export async function primitiveArrayOverlap(): Promise<(1 | 2)[] | (2 | 3)[]> {\n  return Promise.resolve([2]);\n}\n",
  "src/methods/dateOrText.ts":
    "export async function dateOrText(): Promise<string | Date> {\n  return Promise.resolve(new Date(0));\n}\n",
  "src/methods/dateOrIsoLiteral.ts":
    'export async function dateOrIsoLiteral(): Promise<"2026-11-01T09:00:00.000Z" | Date> {\n  return Promise.resolve(new Date(0));\n}\n',
  "src/methods/symbolKey.ts":
    'const secret = Symbol("secret");\nexport async function symbolKey(input: { [secret]: number }): Promise<string> {\n  return Promise.resolve(String(input[secret]));\n}\n',
  "src/methods/mappedSymbolKey.ts":
    'const secret = Symbol("secret");\nexport async function mappedSymbolKey(input: { id: string } & Record<typeof secret, number>): Promise<number> {\n  return Promise.resolve(input[secret]);\n}\n',
  "src/client/leaky.ts":
    'import { listTodos } from "../server/store";\n\nexport function leak(): Promise<number> {\n  return listTodos("any").then((todos) => todos.length);\n}\n',
};

const DERIVE_GENERATED_FILES = [
  "wire.ts",
  "client.ts",
  "server.ts",
  "manifest.json",
  "derive-report.json",
];

const EXPECTED_PLANTED_DERIVE_DIAGNOSTICS = [
  "client/leaky.ts client-reaches-server",
  "methods/arrayOverlap.ts method-result-not-wire",
  "methods/callbacky.ts method-param-not-wire",
  "methods/dateOrIsoLiteral.ts method-result-not-wire",
  "methods/dateOrText.ts method-result-not-wire",
  "methods/mappedSymbolKey.ts method-param-not-wire",
  "methods/optionalArg.ts method-param-not-wire",
  "methods/overlap.ts method-result-not-wire",
  "methods/primitiveArrayOverlap.ts method-result-not-wire",
  "methods/renamed.ts method-export-name",
  "methods/surrogateKey.ts method-param-not-wire",
  "methods/surrogateLiteral.ts method-result-not-wire",
  "methods/symbolKey.ts method-param-not-wire",
  "methods/syncMethod.ts method-must-be-async",
  "methods/voidResult.ts method-result-not-wire",
  "routes/lists/route.ts route-must-be-async",
  "shared/asyncShared.ts shared-must-be-sync",
  "shared/asyncShared.ts shared-must-be-sync",
];

function hopFindingsUnder(binaryPath, workspace, parentDir) {
  const repoDir = join(workspace, parentDir, "repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(
    join(repoDir, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler" }, "include": ["src"] }\n'
  );
  writeFileSync(
    join(repoDir, "package.json"),
    '{ "name": "project-root-probe", "version": "0.0.0", "type": "module", "private": true }\n'
  );
  writeFileSync(
    join(repoDir, "src/owner.ts"),
    "export function loadAccount(accountId: string): string {\n  return accountId.toUpperCase();\n}\n"
  );
  writeFileSync(
    join(repoDir, "src/hop.ts"),
    'import { loadAccount } from "./owner";\n\nfunction fetchAccount(accountId: string): string {\n  return loadAccount(accountId);\n}\n\nexport function render(accountId: string): string {\n  return fetchAccount(accountId);\n}\n'
  );
  const run = spawnSync(binaryPath, ["--format", "json", "src"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  return JSON.parse(String(run.stdout ?? "[]"))
    .flatMap((entry) =>
      entry.messages.map(
        (message) =>
          `${entry.filePath.split("/").pop()}:${message.line} ${message.ruleId}`
      )
    )
    .sort();
}

function verifyNestedPackageRoles(binaryPath, workspace) {
  const monorepoDir = join(workspace, "monorepo");
  const sharedPackageDir = join(monorepoDir, "packages/shared");
  mkdirSync(join(sharedPackageDir, "src"), { recursive: true });
  writeFileSync(
    join(sharedPackageDir, "tsconfig.json"),
    '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler", "types": [] }, "include": ["src"] }\n'
  );
  writeFileSync(
    join(sharedPackageDir, "src/io.ts"),
    "export function readIt(path: string) {\n  return Bun.file(path).text();\n}\n"
  );
  const packageRun = spawnSync(
    binaryPath,
    ["--format", "json", "packages/shared/src/io.ts"],
    { cwd: monorepoDir, encoding: "utf8" }
  );
  assert.deepEqual(
    JSON.parse(String(packageRun.stdout ?? "[]")).flatMap((entry) =>
      entry.messages.map((message) => message.ruleId)
    ),
    ["antidrift/no-bun-api-in-shared"]
  );
}

export function proveProjectRootSmoke(binaryPath) {
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-project-root-"));
  try {
    const plainFindings = hopFindingsUnder(binaryPath, workspace, "plain");
    assert.deepEqual(plainFindings, [
      "hop.ts:3 antidrift/no-pass-through-parameters",
      "hop.ts:3 antidrift/no-wrapping-functions",
      "hop.ts:7 antidrift/no-pass-through-parameters",
      "owner.ts:1 antidrift/no-wrapping-functions",
    ]);
    for (const ancestor of ["build", "dist", "gen", "tests", "fixtures"]) {
      assert.deepEqual(
        hopFindingsUnder(binaryPath, workspace, ancestor),
        plainFindings
      );
    }
    verifyNestedPackageRoles(binaryPath, workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function inferredFindings(binaryPath, cwd, target) {
  const run = spawnSync(binaryPath, ["--format", "json", target], {
    cwd,
    encoding: "utf8",
  });
  return JSON.parse(String(run.stdout ?? "[]")).flatMap((entry) =>
    entry.messages.map((message) => `${message.line} ${message.ruleId}`)
  );
}

const OPTION_FAILURE_PROBES = [
  [
    { name: "antidrift/react-max-component-props", options: [{ max: 0 }] },
    /max must be >= 1/,
  ],
  [
    { name: "antidrift/no-compat-names", options: [{ files: ["["] }] },
    /invalid glob/,
  ],
  [
    { name: "antidrift/no-adhoc-loader", options: [{ owner: "" }] },
    /'owner' must be a non-empty string/,
  ],
  [
    {
      name: "antidrift/no-adhoc-loader",
      options: [{ allowedFiles: [{ path: "x.tsx", reason: "" }] }],
    },
    /'allowedFiles\[\]\.reason' must be a non-empty string/,
  ],
];

export function verifyHeaderAndOptionFailureProbes(
  runHeadlessProbe,
  probeFileA
) {
  for (const [source, expected] of [
    [
      '/** do not edit the retries default */\nexport { foo } from "./bar";\n',
      1,
    ],
    ['/** @generated */\nexport { foo } from "./bar";\n', 0],
    ['"use client";\n// @generated\nexport { foo } from "./bar";\n', 0],
  ]) {
    const diags = runHeadlessProbe({
      version: 2,
      configs: [
        {
          file_paths: [probeFileA],
          rules: [{ name: "antidrift/no-reexport-only-module" }],
        },
      ],
      source_overrides: { [probeFileA]: source },
    });
    assert.equal(diags.length, expected, JSON.stringify(diags));
  }
  for (const [rule, pattern] of OPTION_FAILURE_PROBES) {
    const payload = {
      version: 2,
      configs: [{ file_paths: [probeFileA], rules: [rule] }],
      source_overrides: { [probeFileA]: "export const x = 1;\n" },
    };
    assert.throws(() => runHeadlessProbe(payload), pattern);
  }
}

export function proveInferredTypesSmoke(binaryPath, repoRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-inferred-types-"));
  try {
    const monorepoDir = join(workspace, "monorepo");
    const appDir = join(monorepoDir, "packages/app");
    mkdirSync(join(appDir, "node_modules/@types"), { recursive: true });
    mkdirSync(join(appDir, "scripts"), { recursive: true });
    symlinkSync(
      realpathSync(resolve(repoRoot, "node_modules/@types/node")),
      join(appDir, "node_modules/@types/node"),
      "junction"
    );
    const pkg =
      '{ "name": "probe", "version": "0.0.0", "type": "module", "private": true }\n';
    writeFileSync(join(monorepoDir, "package.json"), pkg);
    writeFileSync(join(appDir, "package.json"), pkg);
    writeFileSync(
      join(appDir, "scripts/probe.mjs"),
      'import { readFileSync } from "node:fs";\nconst fromDisk = JSON.parse(readFileSync("x.json", "utf8"));\nconst fromNowhere = JSON.parse(globalThis.untypedThing);\nconsole.log(fromDisk, fromNowhere);\n'
    );
    assert.deepEqual(
      inferredFindings(
        binaryPath,
        monorepoDir,
        "packages/app/scripts/probe.mjs"
      ),
      ["3 antidrift/no-unsafe-deserialize"]
    );
    assert.deepEqual(
      inferredFindings(binaryPath, appDir, "scripts/probe.mjs"),
      ["3 antidrift/no-unsafe-deserialize"]
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function copyDeriveSample(repoRoot, workspace) {
  const sampleRoot = resolve(repoRoot, "apps/shape-sample");
  const copyRoot = join(workspace, "apps/shape-sample");
  cpSync(
    resolve(repoRoot, "tsconfig.base.json"),
    join(workspace, "tsconfig.base.json")
  );
  symlinkSync(
    resolve(repoRoot, "node_modules"),
    join(workspace, "node_modules"),
    "dir"
  );
  cpSync(sampleRoot, copyRoot, {
    recursive: true,
    filter: (source) =>
      !source.includes("node_modules") && !source.includes("/src/generated"),
  });
  return { sampleRoot, copyRoot };
}

function verifyPlantedDeriveViolations(binaryPath, sampleRoot, copyRoot) {
  for (const [file, source] of Object.entries(PLANTED_DERIVE_VIOLATIONS)) {
    mkdirSync(dirname(join(copyRoot, file)), { recursive: true });
    writeFileSync(join(copyRoot, file), source);
  }
  const plantedRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    plantedRun.status,
    1,
    `${plantedRun.stdout}${plantedRun.stderr}`
  );
  const plantedReport = JSON.parse(
    readFileSync(join(copyRoot, "src/generated/derive-report.json"), "utf8")
  );
  assert.deepEqual(
    plantedReport.diagnostics.map((d) => `${d.file} ${d.rule}`).sort(),
    EXPECTED_PLANTED_DERIVE_DIAGNOSTICS
  );
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  for (const name of DERIVE_GENERATED_FILES) {
    assert.doesNotThrow(() =>
      strictUtf8.decode(readFileSync(join(copyRoot, "src/generated", name)))
    );
  }
  for (const name of ["wire.ts", "client.ts", "server.ts"]) {
    assert.equal(
      readFileSync(join(copyRoot, "src/generated", name), "utf8"),
      readFileSync(join(sampleRoot, "src/generated", name), "utf8")
    );
  }
}

function verifyShapeSampleRuntime(repoRoot) {
  const sampleSmoke = spawnSync(
    resolve(repoRoot, "node_modules/.bin/tsx"),
    ["apps/shape-sample/smoke/run.ts"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(
    sampleSmoke.status,
    0,
    `${sampleSmoke.stdout}${sampleSmoke.stderr}`
  );
  assert.deepEqual(sampleSmoke.stdout.trim().split("\n"), [
    "ok   addTodo round-trips through derived decoders, Date included",
    "ok   malformed wire input fails at the boundary and names the field",
    "ok   completeTodo enforces ownership through the injected session",
    "ok   publication streams typed patches and stops when the client stops",
    "ok   publication withholds other owners' patches",
    "ok   client view model renders the optimistic patch, then the server's",
    "ok   route GET /todos/[id] serves JSON and refuses other owners",
    "7/7 steps passed",
  ]);
}

function verifyAcceptedAndRuntimeProbes(binaryPath, copyRoot) {
  const acceptedFile = join(copyRoot, "src/methods/acceptedShapes.ts");
  writeFileSync(
    acceptedFile,
    'export async function acceptedShapes(input: { a: string } & { b: number }): Promise<Date | "missing"> {\n  return Promise.resolve(input.b > 0 ? new Date(0) : "missing");\n}\n'
  );
  const acceptedRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    acceptedRun.status,
    0,
    `${acceptedRun.stdout}${acceptedRun.stderr}`
  );
  rmSync(acceptedFile);

  const decodePath = join(copyRoot, "src/runtime/decode.ts");
  const decodeSource = readFileSync(decodePath, "utf8");
  rmSync(decodePath);
  const missingRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.notEqual(missingRun.status, 0);
  assert.match(
    `${missingRun.stdout}${missingRun.stderr}`,
    /missing required derive runtime module\(s\): src\/runtime\/decode\.ts/u
  );
  writeFileSync(decodePath, decodeSource);

  assert.deepEqual(parseNameStatusRecords("", "/repo"), []);
  assert.deepEqual(
    parseNameStatusRecords("M\0a.ts\0R100\0old.ts\0new.ts\0", "/repo"),
    [
      { status: "M", operation: "modify", path: "a.ts", oldPath: null },
      {
        status: "R100",
        operation: "rename",
        path: "new.ts",
        oldPath: "old.ts",
      },
    ]
  );
  for (const bad of [
    "M\0\0",
    "R100\0old.ts\0",
    "R100\0old.ts\0\0",
    "M\0ok.ts\0A",
  ]) {
    assert.throws(() => parseNameStatusRecords(bad, "/repo"), TypeError);
  }
}

export function proveDeriveSmoke(binaryPath, repoRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-derive-"));
  try {
    const { sampleRoot, copyRoot } = copyDeriveSample(repoRoot, workspace);
    verifyAcceptedAndRuntimeProbes(binaryPath, copyRoot);
    const cleanRun = spawnSync(binaryPath, ["derive", copyRoot], {
      encoding: "utf8",
    });
    assert.equal(cleanRun.status, 0, `${cleanRun.stdout}${cleanRun.stderr}`);
    for (const name of DERIVE_GENERATED_FILES) {
      assert.equal(
        readFileSync(join(copyRoot, "src/generated", name), "utf8"),
        readFileSync(join(sampleRoot, "src/generated", name), "utf8")
      );
    }
    verifyPlantedDeriveViolations(binaryPath, sampleRoot, copyRoot);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  verifyShapeSampleRuntime(repoRoot);
}
