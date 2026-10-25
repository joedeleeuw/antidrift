import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const childDeclaration =
  "export interface CopiedChild { a: string; b: number; c: boolean }\n";

function emitBundledDeclaration(work) {
  const sourceFile = join(work, "packages/app/src/compiled-inline.ts");
  const outDir = join(work, "packages/app/dist");
  const program = ts.createProgram([sourceFile], {
    declaration: true,
    declarationMap: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmitOnError: true,
    outDir,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const emitted = program.emit();
  const allDiagnostics = [...diagnostics, ...emitted.diagnostics];
  if (allDiagnostics.length > 0 || emitted.emitSkipped) {
    throw new Error(
      `Declaration build failed for ${sourceFile}: ${allDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n")}`
    );
  }
  const declaration = readFileSync(
    join(outDir, "compiled-inline.d.ts"),
    "utf8"
  );
  return declaration.replace(
    "compiled-inline.d.ts.map",
    "compiled-inline-HASH.d.ts.map"
  );
}

export function scaffoldStructuralContracts({ file, work }) {
  const manifest = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
  file(
    "package.json",
    `${JSON.stringify(
      {
        ...manifest,
        devDependencies: {
          ...manifest.devDependencies,
          "first-owner": "workspace:*",
          "second-owner": "workspace:*",
        },
      },
      null,
      2
    )}\n`
  );
  file(
    "packages/first-owner/package.json",
    `${JSON.stringify({ name: "first-owner", type: "module", types: "./index.ts" }, null, 2)}\n`
  );
  file(
    "packages/first-owner/index.ts",
    "export interface OriginalChild { a: string; b: number; c: boolean }\nexport declare function makeChild(): OriginalChild;\n"
  );
  file(
    "packages/second-owner/package.json",
    `${JSON.stringify({ name: "second-owner", type: "module", types: "./index.ts" }, null, 2)}\n`
  );
  file(
    "packages/second-owner/index.ts",
    "export interface Envelope { payload: { a: string; b: number; c: boolean }; meta: string; extra: number }\nexport declare function make(): Envelope;\n"
  );
  file("packages/app/src/nested-contract.ts", childDeclaration);
  file(
    "packages/app/src/nested-envelope.ts",
    'import { make } from "second-owner";\nimport type { CopiedChild } from "./nested-contract.js";\nexport interface LocalEnvelope { payload: CopiedChild; meta: string }\nexport const copied: LocalEnvelope = make();\n'
  );
  file(
    "packages/app/src/compiled-inline.ts",
    "export function formatBundledInput(input: { first: string; second: number; third: boolean }) { return input; }\n"
  );
  file(
    "packages/app/dist/compiled-inline-HASH.d.ts",
    emitBundledDeclaration(work)
  );
  rmSync(join(work, "packages/app/dist/compiled-inline.d.ts"));
  rmSync(join(work, "packages/app/dist/compiled-inline.d.ts.map"));
  file(
    "packages/app/src/compiled-inline-consumer.ts",
    'import { formatBundledInput } from "../dist/compiled-inline-HASH.js";\nvoid formatBundledInput;\n'
  );
}

export function proveStructuralContracts({ file, lint }) {
  const ruleId = "antidrift/no-structural-type-fork";
  const structuralMessages = (paths) =>
    paths
      .flatMap((path) => lint(path))
      .flatMap((lintResult) =>
        lintResult.messages.filter((message) => message.ruleId === ruleId)
      );
  const before = structuralMessages([
    "packages/app/src/nested-contract.ts",
    "packages/app/src/nested-envelope.ts",
  ]);
  if (
    before.length !== 1 ||
    before[0]?.messageId !== "ownedContractProjection"
  ) {
    throw new Error(
      `Nested workspace ownership must report one copied child: ${JSON.stringify(before)}`
    );
  }
  file(
    "packages/app/src/nested-contract.ts",
    `import { makeChild } from "first-owner";\n${childDeclaration}export const directCopy: CopiedChild = makeChild();\n`
  );
  const competing = structuralMessages([
    "packages/app/src/nested-contract.ts",
    "packages/app/src/nested-envelope.ts",
  ]);
  if (competing.length > 0) {
    throw new Error(
      `Competing direct and nested owners must abstain: ${JSON.stringify(competing)}`
    );
  }
  const bundled = structuralMessages([
    "packages/app/src/compiled-inline.ts",
    "packages/app/src/compiled-inline-consumer.ts",
  ]);
  if (bundled.length > 0) {
    throw new Error(
      `Generated declaration bundles must not duplicate their source contracts: ${JSON.stringify(bundled)}`
    );
  }
}
