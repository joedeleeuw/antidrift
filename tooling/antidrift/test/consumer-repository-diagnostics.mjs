import { fail } from "./consumer-process.mjs";

export function proveModuleSizeDiagnostics(repositoryDiagnostics) {
  const moduleSizeDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "antidrift(max-module-lines)"
  );
  const oversizedFiles = moduleSizeDiagnostics
    .map(({ filename }) => filename)
    .sort();
  const expectedOversizedFiles = [
    "convex/oversized.ts",
    "oversized-root.ts",
    "scripts/oversized-script.ts",
    "src/_generated/oversized.ts",
    "src/fixtures/helper.ts",
    "src/generated/oversized.ts",
    "src/undeclared.gen.ts",
    "src/undeclared.generated.ts",
    "tests/oversized-test.ts",
  ].sort();
  if (
    JSON.stringify(oversizedFiles) !== JSON.stringify(expectedOversizedFiles)
  ) {
    fail(
      `default packed Oxlint config should report antidrift/max-module-lines for ordinary code even when generated-looking names are undeclared, got: ${JSON.stringify(moduleSizeDiagnostics)}`
    );
  }
}

export function proveRepositoryRuleDiagnostics(repositoryDiagnostics) {
  const asyncRepositoryDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "antidrift(no-async-array-method)"
  );
  if (
    JSON.stringify(
      asyncRepositoryDiagnostics.map(({ filename }) => filename)
    ) !== JSON.stringify(["packages/app/src/async-foreach-drift.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-async-array-method via native antidrift-linter on async-foreach-drift.ts, got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
  const predicateDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "antidrift(no-underchecked-type-predicate)"
  );
  if (
    JSON.stringify(predicateDiagnostics.map(({ filename }) => filename)) !==
    JSON.stringify(["packages/app/src/underchecked-predicate.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-underchecked-type-predicate via native antidrift-linter, got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
  const structuralForkDiagnostics = repositoryDiagnostics.filter(
    ({ code }) => code === "antidrift(no-structural-type-fork)"
  );
  if (
    JSON.stringify(
      structuralForkDiagnostics.map(({ filename }) => filename)
    ) !== JSON.stringify(["packages/app/src/drift.ts"])
  ) {
    fail(
      `default packed Oxlint config should report antidrift/no-structural-type-fork on drift.ts (and NOT on unaccepted package-copy.ts), got: ${JSON.stringify(repositoryDiagnostics)}`
    );
  }
}

export function proveCleanRepositoryFiles(repositoryDiagnostics) {
  const cleanDiagnostics = repositoryDiagnostics.filter(
    ({ filename }) =>
      filename === "packages/app/src/clean.ts" ||
      filename === "packages/app/src/package-copy.ts" ||
      filename === "packages/app/src/brand.ts" ||
      filename === "packages/app/src/exports.ts"
  );
  if (cleanDiagnostics.length > 0) {
    fail(
      `clean.ts, package-copy.ts, brand.ts, and exports.ts must remain clean, got: ${JSON.stringify(cleanDiagnostics)}`
    );
  }
}
