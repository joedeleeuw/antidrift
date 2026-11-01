import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const oxlint = resolve(repoRoot, "node_modules/.bin/oxlint");
const linter = resolve(repoRoot, "target/debug/antidrift-linter");
const addon = resolve(repoRoot, "target/debug/libantidrift_napi.so");
const tsconfig = {
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
  },
  include: ["src"],
};
const firstCast = 'export const first = ("x" as unknown) as never;\n';
const cleanCast = 'export const first: string = "x";\n';
const secondCast = "export const second = (1 as unknown) as never;\n";
const syncApi =
  "export type Role = string;\nexport declare function read(): void;\n";
const asyncApi =
  'export type Role = "admin" | "member";\nexport declare function read(): Promise<void>;\n';
const callerSource =
  'import { read, type Role } from "./api";\nread();\nexport function parseRole(raw: string) {\n  return raw as Role;\n}\n';

class LspSession {
  constructor(child) {
    this.child = child;
    this.waiting = [];
    this.incoming = Buffer.alloc(0);
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    child.on("error", (error) => this.failWaiting(error));
    child.on("exit", (code, signal) => {
      this.failWaiting(
        new Error(
          `oxlint --lsp exited with code ${code} signal ${signal}: ${this.stderr}`
        )
      );
    });
    child.stdout.on("data", (chunk) => this.receive(chunk));
  }

  failWaiting(error) {
    for (const { reject, timer } of this.waiting.splice(0)) {
      clearTimeout(timer);
      reject(error);
    }
  }

  write(message) {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  receive(chunk) {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    while (true) {
      const headerEnd = this.incoming.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.incoming.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length: (\d+)/u.exec(header)?.[1]);
      assert.ok(Number.isInteger(length), `Invalid LSP header: ${header}`);
      const messageEnd = headerEnd + 4 + length;
      if (this.incoming.length < messageEnd) return;
      const message = JSON.parse(
        this.incoming.subarray(headerEnd + 4, messageEnd).toString("utf8")
      );
      this.incoming = this.incoming.subarray(messageEnd);
      if (message.id !== undefined && message.method) {
        this.write({ jsonrpc: "2.0", id: message.id, result: null });
        continue;
      }
      for (const waiter of this.waiting) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  }

  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for LSP message: ${this.stderr}`));
      }, 10_000);
      const waiter = { predicate, resolve, reject, timer };
      this.waiting.push(waiter);
    });
  }

  async initialize(project) {
    const rootUri = pathToFileURL(project).href;
    const response = this.waitFor((message) => message.id === 1);
    this.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "long-lived-host" }],
        capabilities: {},
        initializationOptions: [
          {
            workspaceUri: rootUri,
            options: { run: "onType", typeAware: true },
          },
        ],
      },
    });
    await response;
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  async diagnostics(label, uri, version) {
    const message = await this.waitFor(
      (candidate) =>
        candidate.method === "textDocument/publishDiagnostics" &&
        candidate.params.uri === uri &&
        candidate.params.version === version
    );
    console.log(`${label} ${JSON.stringify(message)}`);
    return message.params.diagnostics;
  }

  async open(file, text) {
    const uri = pathToFileURL(file).href;
    this.write({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "typescript", version: 1, text },
      },
    });
    return this.diagnostics(`didOpen ${file}`, uri, 1);
  }

  async change(file, text, version) {
    const uri = pathToFileURL(file).href;
    this.write({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    });
    return this.diagnostics(`didChange ${file} v${version}`, uri, version);
  }
}

function writeProject() {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "antidrift-long-lived-host-"))
  );
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(
    join(project, ".oxlintrc.json"),
    JSON.stringify({
      jsPlugins: [
        resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
      ],
      categories: { correctness: "off" },
      rules: {
        "antidrift/no-appeasement-cast": "error",
        "antidrift/no-as-never": "error",
        "typescript/no-floating-promises": "error",
      },
    })
  );
  writeFileSync(
    join(project, "capture-helper.mjs"),
    `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { appendFileSync } from "node:fs";\nconst chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nconst payload = Buffer.concat(chunks);\nappendFileSync(process.env.ANTIDRIFT_HEADLESS_LOG, payload.toString("utf8") + "\\n");\nconst child = spawn(process.env.ANTIDRIFT_LINTER_BIN, process.argv.slice(2), { env: process.env, stdio: ["pipe", "inherit", "inherit"] });\nchild.stdin.end(payload);\nchild.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });\n`,
    { mode: 0o755 }
  );
  writeFileSync(join(project, "src/cast.ts"), firstCast);
  writeFileSync(join(project, "src/api.ts"), syncApi);
  writeFileSync(join(project, "src/caller.ts"), callerSource);
  return project;
}

function codes(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.code).sort();
}

async function proveCastEdits(session, project) {
  const cast = join(project, "src/cast.ts");
  return [
    [
      "initial cast",
      codes(await session.open(cast, firstCast)),
      ["antidrift(no-as-never)"],
    ],
    ["cleaned cast", codes(await session.change(cast, cleanCast, 2)), []],
    [
      "new cast",
      codes(await session.change(cast, secondCast, 3)),
      ["antidrift(no-as-never)"],
    ],
  ];
}

async function proveDependentEdits(session, project) {
  const api = join(project, "src/api.ts");
  const caller = join(project, "src/caller.ts");
  const observed = [
    ["initial api", codes(await session.open(api, syncApi)), []],
    ["initial caller", codes(await session.open(caller, callerSource)), []],
  ];
  writeFileSync(api, asyncApi);
  observed.push([
    "async api",
    codes(await session.change(api, asyncApi, 2)),
    [],
  ]);
  observed.push([
    "dependent caller",
    codes(await session.change(caller, callerSource, 2)),
    ["antidrift(no-appeasement-cast)", "typescript(no-floating-promises)"],
  ]);
  return observed;
}

function proveHelperPayloads(project) {
  const payloads = readFileSync(join(project, "headless.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  console.log(
    `type-aware source_overrides ${JSON.stringify(payloads.map((payload) => payload.source_overrides))}`
  );
  assert.ok(
    payloads.length >= 6 &&
      payloads.every(
        (payload) =>
          payload.source_overrides &&
          Object.keys(payload.source_overrides).length === 1
      ),
    "Every LSP type-aware request must carry its one in-memory source override"
  );
  const caller = join(project, "src/caller.ts");
  assert.equal(
    payloads.at(-1).source_overrides[caller],
    callerSource,
    "The dependent lint must receive the caller's current buffer text"
  );
}

export async function proveLongLivedHost() {
  const project = writeProject();
  const child = spawn(oxlint, ["--lsp"], {
    cwd: project,
    env: {
      ...process.env,
      ANTIDRIFT_NAPI_ADDON: addon,
      OXLINT_TSGOLINT_PATH: join(project, "capture-helper.mjs"),
      ANTIDRIFT_LINTER_BIN: linter,
      ANTIDRIFT_HEADLESS_LOG: join(project, "headless.jsonl"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = new LspSession(child);
  try {
    await session.initialize(project);
    const observed = [
      ...(await proveCastEdits(session, project)),
      ...(await proveDependentEdits(session, project)),
    ];
    proveHelperPayloads(project);
    for (const [label, actual, expected] of observed) {
      assert.deepEqual(actual, expected, `${label} diagnostics are stale`);
    }
    console.log("✓ long-lived Oxlint host smoke passed");
  } finally {
    child.kill("SIGTERM");
    rmSync(project, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await proveLongLivedHost();
}
