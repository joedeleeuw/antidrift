import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
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
execFileSync(
  process.execPath,
  [typescriptCompiler, "-p", "tsconfig.build.json"],
  {
    cwd: packageRoot,
    stdio: "inherit",
  }
);
cpSync(sourceDirectory, outputDirectory, {
  recursive: true,
  filter: (source) =>
    !source.endsWith("/fixtures") && !compiledSource.test(source),
});

const sourceBinary = resolve(repoRoot, "target/release/antidrift-linter");
execFileSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "antidrift-linter"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  }
);
const binDirectory = resolve(outputDirectory, "bin");
const targetBinary = resolve(binDirectory, "antidrift-linter");
mkdirSync(binDirectory, { recursive: true });
cpSync(sourceBinary, targetBinary);
chmodSync(targetBinary, 0o755);
