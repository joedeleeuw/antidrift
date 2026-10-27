import { readFileSync } from "node:fs";
import { join } from "node:path";

const explicitDomainFiles = [
  "precision-proofs/core/entity.ts",
  "precision-proofs/core/ignored.ts",
  "precision-proofs/core/migrations/**",
  "precision-proofs/core/schema.gen.ts",
  "precision-proofs/core/asset.d.ts",
];

const precisionFiles = {
  "precision-proofs/domain/entity.ts": "export default class Entity {}\n",
  "precision-proofs/domain/named.ts": "export class Entity {}\n",
  "precision-proofs/core/entity.ts": "export default class Entity {}\n",
  "precision-proofs/core/platform.ts": 'export default "native-binding";\n',
  "precision-proofs/core/ignored.ts": "export default class Ignored {}\n",
  "precision-proofs/core/migrations/001_init.ts": "export default { up };\n",
  "precision-proofs/core/schema.gen.ts": "export default { tables };\n",
  "precision-proofs/core/asset.d.ts":
    'declare module "*.wasm" { const path: string; export default path; }\n',
  "precision-proofs/stream/unprotected.ts":
    "export async function readOnce(stream: ReadableStream) { const reader = stream.getReader(); return reader.read(); }\n",
  "precision-proofs/stream/safe-let.ts":
    "type Awaitable<T> = T | PromiseLike<T>;\n" +
    "type StreamOutcome = { interrupted: false } | { interrupted: true; error: unknown };\n" +
    "type ChunkConsumer<TChunk, TResult> = { onChunk(chunk: TChunk): Awaitable<void>; onFinish(outcome: StreamOutcome): Awaitable<TResult> };\n" +
    "export async function consumeChunks<TChunk, TResult>(chunks: ReadableStream<TChunk>, consumer: ChunkConsumer<TChunk, TResult>): Promise<TResult> {\n" +
    "  const reader = chunks.getReader();\n" +
    "  let outcome: StreamOutcome = { interrupted: false };\n" +
    "  let cancellation: Promise<void> | undefined;\n" +
    "  try {\n" +
    "    while (true) {\n" +
    "      const { done, value } = await reader.read();\n" +
    "      if (done) break;\n" +
    "      await consumer.onChunk(value);\n" +
    "    }\n" +
    "  } catch (error) {\n" +
    "    outcome = { interrupted: true, error };\n" +
    "    cancellation = reader.cancel().catch(() => {});\n" +
    "  } finally {\n" +
    "    reader.releaseLock();\n" +
    "  }\n" +
    "  try { return await consumer.onFinish(outcome); } finally { await cancellation; }\n" +
    "}\n",
  "precision-proofs/stream/throwing-before-try.ts":
    "export async function consume(stream: ReadableStream, initialize: () => unknown) { const reader = stream.getReader(); let outcome = initialize(); try { while (true) { const { done } = await reader.read(); if (done) break; } } finally { reader.releaseLock(); } return outcome; }\n",
  "precision-proofs/stream/throwing-in-catch.ts":
    "export async function consume(stream: ReadableStream, consumer: { onChunk(value: unknown): Promise<void> }, record: (error: unknown) => { interrupted: boolean }) { const reader = stream.getReader(); let outcome = { interrupted: false }; let cancellation; try { while (true) { const { done, value } = await reader.read(); if (done) break; await consumer.onChunk(value); } } catch (error) { outcome = record(error); cancellation = reader.cancel().catch(() => {}); } finally { reader.releaseLock(); } return outcome; }\n",
  "precision-proofs/stream/safe-transfer.ts":
    "export function transfer(stream: ReadableStream) { const reader = stream.getReader(); let metadata = { owned: true }; let cancellation; return reader; }\n",
  "precision-proofs/stream/throwing-before-return.ts":
    "export function transfer(stream: ReadableStream, initialize: () => unknown) { const reader = stream.getReader(); let metadata = initialize(); return reader; }\n",
  "precision-proofs/stream/destructuring-before-try.ts":
    "export async function consume(stream: ReadableStream, input: { chunk?: unknown }) { const reader = stream.getReader(); const { chunk } = input; try { while (true) { const { done } = await reader.read(); if (done) break; } } finally { reader.releaseLock(); } return chunk; }\n",
  "precision-proofs/stream/using-before-try.ts":
    "export async function consume(stream: ReadableStream, resource: Disposable) { const reader = stream.getReader(); using handle = resource; try { while (true) { const { done } = await reader.read(); if (done) break; } } finally { reader.releaseLock(); } return handle; }\n",
  "precision-proofs/stream/assigned-cancel-tdz.ts":
    "export async function consume(stream: ReadableStream) { const reader = stream.getReader(); try { while (true) { const { done } = await reader.read(); if (done) break; } } finally { later = reader.cancel().catch(() => {}); reader.releaseLock(); let later; } }\n",
  "precision-proofs/stream/assigned-cancel-const.ts":
    "export async function consume(stream: ReadableStream) { const later = undefined; const reader = stream.getReader(); try { while (true) { const { done } = await reader.read(); if (done) break; } } finally { later = reader.cancel().catch(() => {}); reader.releaseLock(); } }\n",
  "precision-proofs/stream/reader-alias-tdz.ts":
    "export async function consume(stream: ReadableStream) { const reader = stream.getReader(); void alias; const alias = reader; try { while (true) { const { done } = await alias.read(); if (done) break; } } finally { reader.releaseLock(); } }\n",
  "packages/app/src/effect-service.ts":
    'import { Context, Effect, Layer } from "effect";\n' +
    "export type Service = { read(): string };\n" +
    'export const Service = Context.Service<Service>("PrecisionService");\n' +
    'export function makeSettings() { return { prefix: "precision" }; }\n' +
    'export function makeService(prefix = "service"): Service { return { read: () => prefix }; }\n' +
    'export function makeExtendedService() { return { read: () => "extended", close: () => {} }; }\n' +
    "export function makeServiceEffect() { return Effect.succeed(makeService()); }\n" +
    "export function makeLayer() { return Layer.succeed(Service, makeService()); }\n" +
    "export const Live = Layer.effect(Service, Effect.map(Effect.succeed(makeSettings()), (settings) => makeService(settings.prefix)));\n" +
    "export const ExtendedLive = Layer.effect(Service, Effect.sync(makeExtendedService));\n",
  "packages/app/src/raw-service.ts":
    'import { makeService, makeExtendedService, makeServiceEffect, makeLayer } from "./effect-service.js";\n' +
    "export const service = makeService();\n" +
    "export const extended = makeExtendedService();\n" +
    "export const serviceEffect = makeServiceEffect();\n" +
    "export const layer = makeLayer();\n",
  "packages/app/src/wiring-helper.ts":
    'import { makeSettings } from "./effect-service.js";\n' +
    "export const settings = makeSettings();\n",
  "packages/app/src/layer-wiring.ts":
    'import { Effect, Layer } from "effect";\n' +
    'import { Service, makeService } from "./effect-service.js";\n' +
    "export const Wired = Layer.effect(Service, Effect.sync(makeService));\n",
  "packages/app/src/effect-service-contract.ts":
    'import { Context } from "effect";\n' +
    "export type ProviderService = { read(): string };\n" +
    'export const ProviderService = Context.Service<ProviderService>("ProviderService");\n',
  "packages/app/src/effect-service-provider.ts":
    'import { Effect, Layer } from "effect";\n' +
    'import { ProviderService } from "./effect-service-contract.js";\n' +
    "const ProviderTag = ProviderService;\n" +
    'export function makeProviderService(): ProviderService { return { read: () => "provider" }; }\n' +
    "export const ProviderLive = Layer.effect(ProviderTag, Effect.sync(makeProviderService));\n",
  "packages/app/src/raw-provider.ts":
    'import { makeProviderService } from "./effect-service-provider.js";\n' +
    "export const provider = makeProviderService();\n",
  "packages/app/src/provider-wiring.ts":
    'import { Effect, Layer } from "effect";\n' +
    'import { ProviderService } from "./effect-service-contract.js";\n' +
    'import { makeProviderService } from "./effect-service-provider.js";\n' +
    "export const ProviderWired = Layer.effect(ProviderService, Effect.sync(makeProviderService));\n",
  "packages/app/src/unknown-service.ts":
    'import { Context, Effect, Layer } from "effect";\n' +
    'export const UnknownService = Context.Service<unknown>("UnknownService");\n' +
    'export function makeUnknownService() { return { read: () => "unknown" }; }\n' +
    "export const UnknownLive = Layer.effect(UnknownService, Effect.sync(makeUnknownService));\n",
  "packages/app/src/raw-unknown-service.ts":
    'import { makeUnknownService } from "./unknown-service.js";\n' +
    "export const unknownService = makeUnknownService();\n",
  "packages/app/src/raw-hogql.ts":
    'export function ordersForUser(userId: string) { return "SELECT * FROM orders WHERE user_id = " + userId; }\n',
  "eslint.precision.config.mjs":
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
    "export default createConfig({ tsconfigRootDir: import.meta.dirname }).map((entry) => ({\n" +
    "  ...entry,\n" +
    '  rules: Object.fromEntries(Object.entries(entry.rules ?? {}).filter(([ruleId]) => ruleId === "antidrift/no-service-constructor-imports")),\n' +
    "}));\n",
  "eslint.sql-opt-in.config.mjs":
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
    "export default createConfig({ tsconfigRootDir: import.meta.dirname }).map((entry) => ({\n" +
    "  ...entry,\n" +
    '  rules: Object.fromEntries(Object.entries(entry.rules ?? {}).filter(([ruleId]) => ruleId === "antidrift/no-sql-string-concat").map(([ruleId]) => [ruleId, "error"])),\n' +
    "}));\n",
  "packages/app/src/vague-name-control.ts": "export const data = 1;\n",
  "eslint.vague-names-opt-in.config.mjs":
    'import { createConfig } from "@joedeleeuw/antidrift/eslint-config";\n' +
    "export default createConfig({ tsconfigRootDir: import.meta.dirname }).map((entry) => ({\n" +
    "  ...entry,\n" +
    '  rules: Object.fromEntries(Object.entries(entry.rules ?? {}).filter(([ruleId]) => ruleId === "antidrift/no-vague-names").map(([ruleId]) => [ruleId, "error"])),\n' +
    "}));\n",
};

export function scaffoldPrecisionProofs({ file, work }) {
  const manifest = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
  manifest.devDependencies.effect = "4.0.6";
  file("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [filename, source] of Object.entries(precisionFiles)) {
    file(filename, source);
  }
  file(
    "precision.config.json",
    JSON.stringify({
      categories: {
        correctness: "off",
        nursery: "off",
        pedantic: "off",
        perf: "off",
        restriction: "off",
        style: "off",
        suspicious: "off",
      },
      jsPlugins: [
        { name: "antidrift", specifier: "@joedeleeuw/antidrift/oxlint-plugin" },
      ],
      rules: { "antidrift/no-default-export-in-domain": "error" },
      overrides: [
        {
          files: explicitDomainFiles,
          rules: {
            "antidrift/no-default-export-in-domain": [
              "error",
              {
                files: explicitDomainFiles,
                excludeFiles: ["**/ignored.ts"],
              },
            ],
          },
        },
        {
          files: ["precision-proofs/stream/*.ts"],
          rules: { "antidrift/require-stream-reader-disposal": "error" },
        },
      ],
    })
  );
}

export function provePrecisionRules({ lint, lintOxlint }) {
  const portableDiagnostics = (
    lintOxlint("precision-proofs", "precision.config.json").diagnostics ?? []
  )
    .map(({ code, filename, message }) => ({ code, filename, message }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  const domainCode = "antidrift(no-default-export-in-domain)";
  const readerCode = "antidrift(require-stream-reader-disposal)";
  const domainMessage =
    "Default exports are banned in domain modules. Use named exports.";
  const releaseMessage =
    "Release this ReadableStream reader's lock in a finally block, or explicitly return the reader to transfer ownership.";
  const expectedPortableDiagnostics = [
    ...["core/entity.ts", "domain/entity.ts"].map((filename) => ({
      code: domainCode,
      filename: `precision-proofs/${filename}`,
      message: domainMessage,
    })),
    ...[
      "assigned-cancel-const",
      "assigned-cancel-tdz",
      "destructuring-before-try",
      "reader-alias-tdz",
      "throwing-before-return",
      "throwing-before-try",
      "unprotected",
      "using-before-try",
    ].map((name) => ({
      code: readerCode,
      filename: `precision-proofs/stream/${name}.ts`,
      message: releaseMessage,
    })),
    {
      code: readerCode,
      filename: "precision-proofs/stream/throwing-in-catch.ts",
      message:
        "This ReadableStream reader can stop before EOF. Cancel it before releasing its lock so the producer is not left active.",
    },
  ].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  if (
    JSON.stringify(portableDiagnostics) !==
    JSON.stringify(expectedPortableDiagnostics)
  ) {
    throw new Error(
      `Precision diagnostics differ: ${JSON.stringify({ portableDiagnostics, expectedPortableDiagnostics })}`
    );
  }

  const serviceRule = "antidrift/no-service-constructor-imports";
  const serviceFiles = [
    "raw-service",
    "raw-provider",
    "raw-unknown-service",
    "wiring-helper",
    "layer-wiring",
    "provider-wiring",
  ];
  const rawFactoryFiles = new Set([
    "packages/app/src/raw-service.ts",
    "packages/app/src/raw-provider.ts",
  ]);
  const expectedConstructors = [
    "makeService",
    "makeExtendedService",
    "makeServiceEffect",
    "makeProviderService",
  ];
  const serviceFindings = serviceFiles.flatMap((name) => {
    const filename = `packages/app/src/${name}.ts`;
    return lint(filename, "eslint.precision.config.mjs").flatMap(
      (lintResult) => {
        for (const message of lintResult.messages) {
          if (message.ruleId !== serviceRule) {
            throw new Error(
              `Unexpected precision lint result: ${JSON.stringify({ filename, message })}`
            );
          }
        }
        return lintResult.messages.map((message) => ({
          filename,
          message: message.message,
        }));
      }
    );
  });
  if (
    serviceFindings.length !== expectedConstructors.length ||
    serviceFindings.some((finding) => !rawFactoryFiles.has(finding.filename)) ||
    expectedConstructors.some(
      (constructorName) =>
        !serviceFindings.some((finding) =>
          finding.message.includes(`raw constructor '${constructorName}'`)
        )
    )
  ) {
    throw new Error(
      `Service-constructor precision differs: ${JSON.stringify(serviceFindings)}`
    );
  }
  const sqlRule = "antidrift/no-sql-string-concat";
  const sqlFilename = "packages/app/src/raw-hogql.ts";
  const sqlFindings = (config) =>
    lint(sqlFilename, config).flatMap((lintResult) => {
      const parserErrors = lintResult.messages.filter(
        (message) => message.fatal
      );
      if (parserErrors.length > 0) {
        throw new Error(
          `SQL control could not be analyzed: ${JSON.stringify(parserErrors)}`
        );
      }
      return lintResult.messages.filter(
        (message) => message.ruleId === sqlRule
      );
    });
  const defaultSqlFindings = sqlFindings("eslint.config.mjs");
  const optedInSqlFindings = sqlFindings("eslint.sql-opt-in.config.mjs");
  if (defaultSqlFindings.length !== 0 || optedInSqlFindings.length !== 1) {
    throw new Error(
      `SQL default/opt-in behavior differs: ${JSON.stringify({ defaultSqlFindings, optedInSqlFindings })}`
    );
  }
  const vagueNameRule = "antidrift/no-vague-names";
  const vagueNameFilename = "packages/app/src/vague-name-control.ts";
  const vagueNameFindings = (config) =>
    lint(vagueNameFilename, config).flatMap((lintResult) =>
      lintResult.messages.filter((message) => message.ruleId === vagueNameRule)
    );
  const defaultVagueNameFindings = vagueNameFindings("eslint.config.mjs");
  const optedInVagueNameFindings = vagueNameFindings(
    "eslint.vague-names-opt-in.config.mjs"
  );
  if (
    defaultVagueNameFindings.length !== 0 ||
    optedInVagueNameFindings.length !== 1
  ) {
    throw new Error(
      `Vague-name default/opt-in behavior differs: ${JSON.stringify({ defaultVagueNameFindings, optedInVagueNameFindings })}`
    );
  }
  console.log(
    "     precision: domain, Effect, reader, SQL, and vague-name default/opt-in controls preserved"
  );
}
