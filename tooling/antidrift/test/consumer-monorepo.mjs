// Integration test: proves the PUBLISHED tarball works when a downstream monorepo installs it.
//
// Unlike the unit tests (which import source directly), this packs the package the way `npm
// publish` would — resolving catalogs, applying `files`/`exports` — installs that tarball into a
// throwaway pnpm workspace, and runs ESLint through the shipped `eslint-config`. If a subpath
// export is wrong, a dependency is missing, or a config path breaks once linked from node_modules,
// this fails where the unit tests would not.
//
// Opt-in (network/store + install cost): `pnpm test:integration`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "antidrift-consumer-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function file(rel, contents) {
  const path = join(work, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  console.error(`  (left workspace for inspection: ${work})`);
  process.exit(1);
}

try {
  console.log("1/4  packing @joedeleeuw/antidrift …");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);

  console.log("2/4  scaffolding a consumer pnpm workspace …");
  file("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  file("package.json", JSON.stringify({
    name: "antidrift-consumer-fixture",
    private: true,
    type: "module",
    devDependencies: {
      "@joedeleeuw/antidrift": `file:${tarball}`,
      eslint: "^9",
      "typescript-eslint": "^8",
      "@typescript-eslint/parser": "^8",
      typescript: "^5",
      firebase: "^11",
    },
  }, null, 2) + "\n");
  file("tsconfig.base.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true,
    },
  }, null, 2) + "\n");
  file("eslint.config.mjs",
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
    "export default createConfig({ tsconfigRootDir: import.meta.dirname });\n");
  file("packages/app/tsconfig.json", JSON.stringify({
    extends: "../../tsconfig.base.json", include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  // Imports a firebase type and uses it — makes firebase types canonical in the program.
  file("packages/app/src/clean.ts",
    'import type { User } from "firebase/auth";\n' +
    'export function displayName(u: User): string {\n  return u.displayName ?? "anon";\n}\n');
  // Hand-redeclares firebase/auth UserInfo — the structural fork the rule must catch from a tarball.
  file("packages/app/src/drift.ts",
    "export type AuthUser = {\n" +
    "  uid: string;\n  email: string | null;\n  displayName: string | null;\n" +
    "  photoURL: string | null;\n  providerId: string;\n  phoneNumber: string | null;\n};\n");

  console.log("3/4  installing the tarball into the consumer …");
  run("pnpm", ["install", "--config.confirmModulesPurge=false"], work);

  console.log("4/4  linting consumer files through the shipped config …");
  function lint(relFile) {
    try {
      const out = run("pnpm", ["exec", "eslint", relFile, "--format", "json"], work);
      return JSON.parse(out);
    } catch (err) {
      // ESLint exits non-zero when it reports problems; the JSON is still on stdout.
      if (err.stdout) return JSON.parse(err.stdout);
      throw err;
    }
  }

  const RULE = "antidrift/no-structural-type-fork";
  const driftRules = lint("packages/app/src/drift.ts").flatMap((r) => r.messages.map((m) => m.ruleId));
  const cleanRules = lint("packages/app/src/clean.ts").flatMap((r) => r.messages.map((m) => m.ruleId));

  if (!driftRules.includes(RULE)) {
    fail(`drift.ts should have reported ${RULE}, got: ${JSON.stringify(driftRules)}`);
  }
  if (cleanRules.includes(RULE)) {
    fail(`clean.ts (legitimate firebase import) must NOT report ${RULE}, got: ${JSON.stringify(cleanRules)}`);
  }

  console.log(`\n✓ tarball installs and enforces in a consumer monorepo`);
  console.log(`  drift.ts → ${RULE} fired; clean.ts stayed clean.`);
  rmSync(work, { recursive: true, force: true });
} catch (err) {
  console.error(err.stdout || err.message || err);
  fail("integration run threw");
}
