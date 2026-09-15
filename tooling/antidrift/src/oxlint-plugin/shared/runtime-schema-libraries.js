const runtimeSchemaLibrarySources = [
  "@effect/schema",
  "@sinclair/typebox",
  "arktype",
  "effect/Schema",
  "superstruct",
  "valibot",
  "yup",
  "zod",
];

export function isRuntimeSchemaLibrarySource(value) {
  if (typeof value !== "string") return false;
  return runtimeSchemaLibrarySources.some(
    (source) => value === source || value.startsWith(`${source}/`),
  );
}
