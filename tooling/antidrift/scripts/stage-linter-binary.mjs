import { chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error(
    "Usage: node scripts/stage-linter-binary.mjs <source-binary> <target-binary>"
  );
}

const sourceBinary = resolve(sourceArgument);
const targetBinary = resolve(targetArgument);
if (!existsSync(sourceBinary)) {
  throw new Error(`Missing antidrift-linter binary at ${sourceBinary}`);
}
mkdirSync(dirname(targetBinary), { recursive: true });
cpSync(sourceBinary, targetBinary);
if (process.platform !== "win32") {
  chmodSync(targetBinary, 0o755);
}
