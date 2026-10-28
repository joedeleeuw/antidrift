import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
const sourceDirectory = `${packageRoot}src`;
const outputDirectory = `${packageRoot}dist`;
const compiledSource = /(?<!\.d)\.(?:ts|mjs|js)$/u;
const typescriptCompiler = createRequire(import.meta.url).resolve(
  "typescript/bin/tsc"
);

rmSync(outputDirectory, { recursive: true, force: true });
for (const project of ["tsconfig.build.json", "tsconfig.declarations.json"]) {
  execFileSync(process.execPath, [typescriptCompiler, "-p", project], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}
cpSync(sourceDirectory, outputDirectory, {
  recursive: true,
  filter: (source) =>
    !source.endsWith("/fixtures") && !compiledSource.test(source),
});

const binaryCandidates = [
  resolve(repoRoot, "target/release/antidrift-linter"),
  resolve(repoRoot, "target/debug/antidrift-linter"),
];
const sourceBinary = binaryCandidates.find((candidate) =>
  existsSync(candidate)
);
if (!sourceBinary) {
  throw new Error(
    `Missing native antidrift-linter binary at ${binaryCandidates.join(" or ")}; build crates/antidrift-linter first.`
  );
}
const binDirectory = resolve(outputDirectory, "bin");
const targetBinary = resolve(binDirectory, "antidrift-linter");
mkdirSync(binDirectory, { recursive: true });
cpSync(sourceBinary, targetBinary);
chmodSync(targetBinary, 0o755);
