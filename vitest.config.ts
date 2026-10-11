import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}

// Tests create their scratch directories with os.tmpdir(); point it at one run
// directory and remove that when the run ends, so no test leaves files behind.
const runScratch = mkdtempSync(join(tmpdir(), "antidrift-vitest-"));
process.env.TMPDIR = runScratch;
process.on("exit", () => {
  rmSync(runScratch, { recursive: true, force: true });
});

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    globals: true,
  },
});
