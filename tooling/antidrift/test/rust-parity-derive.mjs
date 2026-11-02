import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  "src/methods/defaultArg.ts":
    'export async function defaultArg(note: string = "default"): Promise<string> {\n  return Promise.resolve(note);\n}\n',
  "src/methods/restArg.ts":
    "export async function restArg(...numbers: number[]): Promise<number> {\n  return Promise.resolve(numbers.length);\n}\n",
  "src/methods/expectString.ts":
    "export async function expectString(label: string): Promise<string> {\n  return Promise.resolve(label);\n}\n",
  "src/methods/decodeAddTodoResult.ts":
    "export async function decodeAddTodoResult(label: string): Promise<string> {\n  return Promise.resolve(label);\n}\n",
  "src/methods/shadowCallMethod.ts":
    "export async function shadowCallMethod(callMethod: string): Promise<string> {\n  return Promise.resolve(callMethod);\n}\n",
  "src/methods/nested/addTodo.ts":
    "export async function addTodo(label: string): Promise<string> {\n  return Promise.resolve(label);\n}\n",
  "src/pubs/completeTodo.ts":
    'export async function* completeTodo(): AsyncGenerator<string> {\n  yield "done";\n}\n',
  "src/methods/brokenImport.ts":
    'import type { MissingWire } from "../shared/missingWire";\nexport async function brokenImport(input: MissingWire): Promise<string> {\n  return Promise.resolve(String(input));\n}\n',
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
  "src/methods/stringEnum.ts":
    'enum Level { Low = "low", High = "high" }\nexport async function stringEnum(level: Level): Promise<string> {\n  return Promise.resolve(level);\n}\n',
  "src/methods/numericEnum.ts":
    "enum Rank { One, Two }\nexport async function numericEnum(): Promise<Rank> {\n  return Promise.resolve(Rank.One);\n}\n",
  "src/client/leaky.ts":
    'import { listTodos } from "../server/store";\n\nexport function leak(): Promise<number> {\n  return listTodos("any").then((todos) => todos.length);\n}\n',
  "src/client/dyn.ts":
    'export async function loadStore(): Promise<number> {\n  const store = await import("../server/store");\n  const rows = await store.listTodos("any");\n  return rows.length;\n}\n',
  "src/client/viaTable.ts":
    'import { dispatch } from "../generated/server";\nexport function hasDispatch(): boolean {\n  return typeof dispatch === "object";\n}\n',
};

const DERIVE_GENERATED_FILES = [
  "wire.ts",
  "client.ts",
  "server.ts",
  "manifest.json",
  "derive-report.json",
];

const EXPECTED_PLANTED_DERIVE_DIAGNOSTICS = [
  "client/dyn.ts client-reaches-server",
  "client/leaky.ts client-reaches-server",
  "client/viaTable.ts client-reaches-server",
  "methods/arrayOverlap.ts method-result-not-wire",
  "methods/brokenImport.ts type-script-diagnostic",
  "methods/callbacky.ts method-param-not-wire",
  "methods/dateOrIsoLiteral.ts method-result-not-wire",
  "methods/dateOrText.ts method-result-not-wire",
  "methods/decodeAddTodoResult.ts reserved-generated-identifier",
  "methods/defaultArg.ts method-param-not-wire",
  "methods/expectString.ts reserved-generated-identifier",
  "methods/mappedSymbolKey.ts method-param-not-wire",
  "methods/nested/addTodo.ts duplicate-wire-name",
  "methods/numericEnum.ts method-result-not-wire",
  "methods/optionalArg.ts method-param-not-wire",
  "methods/overlap.ts method-result-not-wire",
  "methods/primitiveArrayOverlap.ts method-result-not-wire",
  "methods/renamed.ts method-export-name",
  "methods/restArg.ts method-param-not-wire",
  "methods/shadowCallMethod.ts reserved-generated-identifier",
  "methods/stringEnum.ts method-param-not-wire",
  "methods/surrogateKey.ts method-param-not-wire",
  "methods/surrogateLiteral.ts method-result-not-wire",
  "methods/symbolKey.ts method-param-not-wire",
  "methods/syncMethod.ts method-must-be-async",
  "methods/voidResult.ts method-result-not-wire",
  "pubs/completeTodo.ts duplicate-wire-name",
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
  for (const enumFile of ["methods/stringEnum.ts", "methods/numericEnum.ts"]) {
    const diag = plantedReport.diagnostics.find((d) => d.file === enumFile);
    assert.match(diag?.message ?? "", /TypeScript enum.*literal union/u);
  }
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  for (const name of DERIVE_GENERATED_FILES) {
    assert.doesNotThrow(() =>
      strictUtf8.decode(readFileSync(join(copyRoot, "src/generated", name)))
    );
  }
  for (const name of ["wire.ts", "client.ts", "server.ts", "manifest.json"]) {
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
    "ok   watchTodos cancel removes abort listener so later abort stays clean",
    "ok   idle follow resolves when signal aborts and detaches the store sink",
    "ok   aborting a publication request detaches the store sink",
    "10/10 steps passed",
  ]);
}

function verifyProtoAndTsconfigDeriveProbes(binaryPath, copyRoot) {
  const protoFile = join(copyRoot, "src/methods/protoKey.ts");
  writeFileSync(
    protoFile,
    'export async function protoKey(input: { ["__proto__"]: string }): Promise<{ ["__proto__"]: string }> {\n  return Promise.resolve({ ["__proto__"]: input["__proto__"] });\n}\n'
  );
  const protoRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(protoRun.status, 0, `${protoRun.stdout}${protoRun.stderr}`);
  assert.match(
    readFileSync(join(copyRoot, "src/generated/wire.ts"), "utf8"),
    /\["__proto__"\]/u
  );
  rmSync(protoFile);

  const tsconfigPath = join(copyRoot, "tsconfig.json");
  const originalTsconfig = readFileSync(tsconfigPath, "utf8");
  writeFileSync(
    tsconfigPath,
    '{ "compilerOptions": { "target": "es2525", "unknownFlag": true }, "include": ["src"] }\n'
  );
  const badRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(badRun.status, 1, `${badRun.stdout}${badRun.stderr}`);
  const badReport = JSON.parse(
    readFileSync(join(copyRoot, "src/generated/derive-report.json"), "utf8")
  );
  assert.deepEqual(
    badReport.diagnostics.map((d) => `${d.file} ${d.rule}`),
    [
      "tsconfig.json type-script-diagnostic",
      "tsconfig.json type-script-diagnostic",
    ]
  );
  writeFileSync(tsconfigPath, originalTsconfig);
}

function verifyAcceptedAndRuntimeProbes(binaryPath, copyRoot, repoRoot) {
  verifyProtoAndTsconfigDeriveProbes(binaryPath, copyRoot);
  const acceptedFile = join(copyRoot, "src/methods/acceptedShapes.ts");
  writeFileSync(
    acceptedFile,
    'export async function acceptedShapes(input: { a: string } & { b: number }): Promise<{ kind: "a"; id: string; at: Date | "missing" }[] | { kind: "b"; id: string; detail: number }[]> {\n  return Promise.resolve([{ kind: "a", id: input.a, at: input.b > 0 ? new Date(0) : "missing" }]);\n}\n'
  );
  const acceptedRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    acceptedRun.status,
    0,
    `${acceptedRun.stdout}${acceptedRun.stderr}`
  );
  const tscRun = spawnSync(
    resolve(repoRoot, "node_modules/.bin/tsc"),
    ["-p", copyRoot, "--noEmit", "--pretty", "false"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(tscRun.status, 0, `${tscRun.stdout}${tscRun.stderr}`);
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
}

export function proveDeriveSmoke(binaryPath, repoRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-derive-"));
  try {
    const { sampleRoot, copyRoot } = copyDeriveSample(repoRoot, workspace);
    verifyAcceptedAndRuntimeProbes(binaryPath, copyRoot, repoRoot);
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
