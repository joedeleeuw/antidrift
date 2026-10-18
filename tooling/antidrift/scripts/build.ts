import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
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
