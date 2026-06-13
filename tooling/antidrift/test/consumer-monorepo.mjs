import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "antidrift-consumer-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runJson(cmd, args, cwd) {
  return JSON.parse(run(cmd, args, cwd));
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
  console.log("1/6  packing @joedeleeuw/antidrift ...");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("pack produced no tarball");
  const tarball = join(work, tgz);

  console.log("2/6  scaffolding a consumer pnpm workspace ...");
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
  const baseCompilerOptions = {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmit: true,
  };
  file("tsconfig.base.json", JSON.stringify({
    compilerOptions: baseCompilerOptions,
  }, null, 2) + "\n");
  file("tsconfig.bundler.json", JSON.stringify({
    compilerOptions: {
      ...baseCompilerOptions,
    },
    include: ["packages/app/src/**/*.ts"],
  }, null, 2) + "\n");
  file("tsconfig.nodenext.json", JSON.stringify({
    compilerOptions: {
      ...baseCompilerOptions,
      module: "NodeNext",
      moduleResolution: "NodeNext",
    },
    include: ["packages/app/src/**/*.ts"],
  }, null, 2) + "\n");
  file("eslint.config.mjs",
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
    "export default createConfig({ tsconfigRootDir: import.meta.dirname });\n");
  file("packages/app/tsconfig.json", JSON.stringify({
    extends: "../../tsconfig.base.json",
    include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  file("packages/app/src/clean.ts",
    'import type { User } from "firebase/auth";\n' +
    'export function displayName(u: User): string {\n  return u.displayName ?? "anon";\n}\n');
  file("packages/app/src/drift.ts",
    "export type AuthUser = {\n" +
    "  uid: string;\n  email: string | null;\n  displayName: string | null;\n" +
    "  photoURL: string | null;\n  providerId: string;\n  phoneNumber: string | null;\n};\n");
  file("packages/app/src/brand.ts",
    'import { brand, type Brand, type Unbrand } from "@joedeleeuw/antidrift/brand";\n' +
    'const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));\n' +
    'type UserId = Brand<string, "UserId">;\n' +
    "type RawUserId = Unbrand<UserId>;\n" +
    "declare const raw: unknown;\n" +
    "const branded = UserId.make(raw);\n" +
    'const rawLiteral: RawUserId = "user_123";\n' +
    "branded satisfies UserId;\n" +
    "rawLiteral satisfies string;\n");
  file("packages/app/src/exports.ts",
    'import type { ESLint, Linter } from "eslint";\n' +
    'import { createConfig, eslintPlugin, loadPolicy, loadRegistriesSync, renderPolicyArtifacts, type AgentGuardrailsPolicy, type AntidriftConfigOptions, type AntidriftRegistries, type PolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
    'import { brand, type Brand, type BrandKit, type BrandSafeResult, type Unbrand } from "@joedeleeuw/antidrift/brand";\n' +
    'import plugin from "@joedeleeuw/antidrift/eslint-plugin";\n' +
    'import { createConfig as createConfigFromSubpath, type AntidriftConfigOptions as SubpathConfigOptions } from "@joedeleeuw/antidrift/eslint-config";\n' +
    'import { checkGenerated, checkRegistries, checkRuleSurface, eslintJsonToSonar, externalCorpus, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, repoCorpus, verifySession, type AgentGuardrailsPolicy as PolicySubpathPolicy } from "@joedeleeuw/antidrift/policy";\n' +
    "\n" +
    "const options = { tsconfigRootDir: \".\" } satisfies AntidriftConfigOptions;\n" +
    "const subpathOptions = { policyDir: \"policy\" } satisfies SubpathConfigOptions;\n" +
    "const policy = { clusters: [] } satisfies AgentGuardrailsPolicy;\n" +
    "const subpathPolicy = policy satisfies PolicySubpathPolicy;\n" +
    "const artifacts = renderPolicyArtifacts(policy);\n" +
    "const branded = brand(\"UserId\", (value): value is string => typeof value === \"string\");\n" +
    "\n" +
    "createConfig(options) satisfies Linter.Config[];\n" +
    "createConfigFromSubpath(subpathOptions) satisfies Linter.Config[];\n" +
    "eslintPlugin satisfies ESLint.Plugin;\n" +
    "plugin satisfies ESLint.Plugin;\n" +
    "artifacts satisfies PolicyArtifacts;\n" +
    "loadRegistriesSync satisfies (policyDir?: string) => AntidriftRegistries;\n" +
    "loadPolicy satisfies (policyPath?: string) => Promise<AgentGuardrailsPolicy>;\n" +
    "loadPolicyFromPolicy satisfies (policyPath?: string) => Promise<PolicySubpathPolicy>;\n" +
    "loadRegistriesFromPolicy satisfies (policyDir?: string) => AntidriftRegistries;\n" +
    "renderPolicyArtifactsFromPolicy(subpathPolicy) satisfies PolicyArtifacts;\n" +
    "branded satisfies BrandKit<string, \"UserId\">;\n" +
    "branded.make(\"user_123\") satisfies Brand<string, \"UserId\">;\n" +
    "branded.safe(\"user_123\") satisfies BrandSafeResult<string, \"UserId\">;\n" +
    "\"user_123\" satisfies Unbrand<Brand<string, \"UserId\">>;\n" +
    "void checkGenerated;\n" +
    "void checkRegistries;\n" +
    "void checkRuleSurface;\n" +
    "void eslintJsonToSonar;\n" +
    "void externalCorpus;\n" +
    "void generate;\n" +
    "void repoCorpus;\n" +
    "void verifySession;\n");
  file("packages/app/src/runtime.mjs",
    'import { createConfig, eslintPlugin, loadPolicy, loadRegistriesSync, renderPolicyArtifacts } from "@joedeleeuw/antidrift";\n' +
    'import { brand } from "@joedeleeuw/antidrift/brand";\n' +
    'import plugin from "@joedeleeuw/antidrift/eslint-plugin";\n' +
    'import { createConfig as createConfigFromSubpath } from "@joedeleeuw/antidrift/eslint-config";\n' +
    'import { checkGenerated, checkRegistries, checkRuleSurface, eslintJsonToSonar, externalCorpus, generate, loadPolicy as loadPolicyFromPolicy, loadRegistriesSync as loadRegistriesFromPolicy, renderPolicyArtifacts as renderPolicyArtifactsFromPolicy, repoCorpus, verifySession } from "@joedeleeuw/antidrift/policy";\n' +
    "\n" +
    "const exportsToCheck = {\n" +
    "  createConfig,\n" +
    "  eslintPlugin,\n" +
    "  loadPolicy,\n" +
    "  loadRegistriesSync,\n" +
    "  renderPolicyArtifacts,\n" +
    "  brand,\n" +
    "  plugin,\n" +
    "  createConfigFromSubpath,\n" +
    "  checkGenerated,\n" +
    "  checkRegistries,\n" +
    "  checkRuleSurface,\n" +
    "  eslintJsonToSonar,\n" +
    "  externalCorpus,\n" +
    "  generate,\n" +
    "  loadPolicyFromPolicy,\n" +
    "  loadRegistriesFromPolicy,\n" +
    "  renderPolicyArtifactsFromPolicy,\n" +
    "  repoCorpus,\n" +
    "  verifySession,\n" +
    "};\n" +
    "\n" +
    "for (const [name, value] of Object.entries(exportsToCheck)) {\n" +
    "  if (typeof value !== \"function\" && typeof value !== \"object\") {\n" +
    "    throw new Error(`Missing runtime export: ${name}`);\n" +
    "  }\n" +
    "}\n");

  console.log("3/6  installing the tarball into the consumer ...");
  run("pnpm", ["install", "--config.confirmModulesPurge=false"], work);

  console.log("4/6  linting consumer files through the shipped config ...");
  function lint(relFile) {
    try {
      return runJson("pnpm", ["exec", "eslint", relFile, "--format", "json"], work);
    } catch (error) {
      if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") {
        return JSON.parse(error.stdout);
      }
      throw error;
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

  console.log("5/6  typechecking every public export under supported TS resolution modes ...");
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.bundler.json", "--pretty", "false"], work);
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.nodenext.json", "--pretty", "false"], work);

  console.log("6/6  importing every public runtime export ...");
  run("node", ["packages/app/src/runtime.mjs"], work);

  console.log(`\n✓ tarball installs, type-checks, imports, and enforces in a consumer monorepo`);
  console.log(`  drift.ts -> ${RULE} fired; clean.ts stayed clean; public exports passed Bundler and NodeNext.`);
  rmSync(work, { recursive: true, force: true });
} catch (error) {
  console.error(error.stdout || error.stderr || error.message || error);
  fail("integration run threw");
}
