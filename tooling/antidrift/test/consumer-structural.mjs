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
    `${JSON.stringify({ name: "first-owner", type: "module", types: "./index.ts", exports: { ".": "./index.ts", "./a": "./a.ts", "./b": "./b.ts", "./c": "./c.ts" } }, null, 2)}\n`
  );
  file(
    "packages/first-owner/index.ts",
    "export interface OriginalChild { a: string; b: number; c: boolean }\nexport declare function makeChild(): OriginalChild;\n"
  );
  const independentContract =
    "export interface Contract { a: string; b: number; c: boolean }\nexport declare function make(): Contract;\n";
  file("packages/first-owner/a.ts", independentContract);
  file("packages/first-owner/b.ts", independentContract);
  file("packages/first-owner/c.ts", independentContract);
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
    "packages/app/src/inline-owner-projection.ts",
    'import { makeChild } from "first-owner";\nexport function readInput(input: { a: string; b: number; c: boolean }) { return input; }\nexport const copied = readInput(makeChild());\n'
  );
  file(
    "packages/app/src/n-way-local.ts",
    'import { makeChild } from "first-owner";\nexport interface FirstCopy { a: string; b: number; c: boolean }\nexport interface SecondCopy { a: string; b: number; c: boolean }\nexport interface ThirdCopy { a: string; b: number; c: boolean }\nexport const first: FirstCopy = makeChild();\nexport const second: SecondCopy = makeChild();\nexport const third: ThirdCopy = makeChild();\n'
  );
  file(
    "packages/app/src/n-way-owners.ts",
    'import { make as makeA } from "first-owner/a";\nimport { make as makeB } from "first-owner/b";\nimport { make as makeC } from "first-owner/c";\ndeclare const firstBranch: boolean;\ndeclare const secondBranch: boolean;\nexport interface Copied { a: string; b: number; c: boolean }\nlet copied: Copied;\nif (firstBranch) {\n  copied = makeA();\n} else if (secondBranch) {\n  copied = makeB();\n} else {\n  copied = makeC();\n}\nexport { copied };\n'
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
  const inlineOnly = structuralMessages([
    "packages/app/src/inline-owner-projection.ts",
  ]);
  if (
    inlineOnly.length !== 1 ||
    inlineOnly[0]?.messageId !== "ownedContractProjection"
  ) {
    throw new Error(
      `Inline-only ownership must initialize provenance scope: ${JSON.stringify(inlineOnly)}`
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
  const localCopies = structuralMessages(["packages/app/src/n-way-local.ts"]);
  if (
    localCopies.length !== 3 ||
    localCopies.some(
      (message) => message.messageId !== "ownedContractProjection"
    ) ||
    localCopies.map((message) => message.line).join(",") !== "2,3,4"
  ) {
    throw new Error(
      `Each of three local contract copies must report: ${JSON.stringify(localCopies)}`
    );
  }
  const independentOwners = structuralMessages([
    "packages/app/src/n-way-owners.ts",
  ]);
  if (independentOwners.length > 0) {
    throw new Error(
      `Three independent plausible owners must abstain: ${JSON.stringify(independentOwners)}`
    );
  }
}
