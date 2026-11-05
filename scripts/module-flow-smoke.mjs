import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ruleId = "antidrift/optional-input-earns-optionality";

const rootSources = {
  "flow-default.ts": `export function viaDefault(x?: string) { return x; }
viaDefault("a");
`,
  "flow-default-barrel.ts": `export { viaDefault as default } from "./flow-default";
`,
  "flow-narrowed.ts": `export function viaNarrowed(input: { label: string; x?: string }) { return input.x; }
const full = { label: "a", x: "b" };
const narrow: { label: string } = full;
export const narrowed = viaNarrowed(narrow);
export function viaRecord(input: { x?: string }) { return input.x; }
const bag: Record<string, string> = { x: "b" };
export const recorded = viaRecord(bag);
`,
  "flow-namespace.ts": `export function viaNamespace(x?: string) { return x; }
viaNamespace("a");
`,
  "flow-computed.ts": `export function viaComputed(x?: string) { return x; }
viaComputed("a");
`,
  "flow-consumers.ts": `import chosen from "./flow-default-barrel";
import * as computed from "./flow-computed";
import * as namespaced from "./flow-namespace";
chosen();
computed["viaComputed"]();
export const exposedNamespace = namespaced;
`,
  "flow-reported.tsx": `export class Reader {
  read(x?: string) { return x; }
}
export const readValue = new Reader().read("a");
function API({ x }: { x?: string }) { return <span>{x}</span>; }
export const apiElement = <API />;
`,
};

const entrySources = {
  "package.json": JSON.stringify({
    name: "flow-entry",
    private: true,
    exports: "./dist/main.js",
    types: "./dist/main.d.ts",
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      noEmit: true,
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src/*.ts"],
  }),
  "src/main.ts": `import { helper } from "./helper";
export function viaEntry(x?: string) { return x; }
viaEntry("a");
export const helped = helper();
`,
  "src/helper.ts": `export function helper(x?: string) { return x; }
`,
};

const expectedReports = [
  "flow-reported.tsx: Optional input 'x' is passed by all 1 call sites; make it required.",
  "flow-reported.tsx: Optional input 'x' is never passed by any of its 1 call sites; delete it.",
  "flow-entry/src/helper.ts: Optional input 'x' is never passed by any of its 1 call sites; delete it.",
];

function writeSources(directory, sources) {
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), source, "utf8");
  }
}

export function writeModuleFlowProject(workDir) {
  writeSources(workDir, rootSources);
  writeSources(join(workDir, "flow-entry"), entrySources);
}

export async function assertModuleFlowCompleteness(workDir, eslint) {
  const lintedFiles = [
    ...Object.keys(rootSources),
    "flow-entry/src/main.ts",
    "flow-entry/src/helper.ts",
  ];
  const lintReports = await eslint.lintFiles(
    lintedFiles.map((file) => join(workDir, file))
  );
  const reports = lintReports.flatMap((fileResult) =>
    fileResult.messages
      .filter((message) => message.ruleId === ruleId)
      .map(
        (message) =>
          `${fileResult.filePath.slice(workDir.length + 1)}: ${message.message}`
      )
  );
  assert.deepEqual(
    reports.toSorted(),
    expectedReports.toSorted(),
    `Expected ${ruleId} to abstain on every incomplete module flow and report only the proven controls`
  );
}
