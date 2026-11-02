import { isAbsolute, matchesGlob, relative } from "node:path";

export const scopeProperties = {
  files: { type: "array", items: { type: "string" } },
  excludeFiles: { type: "array", items: { type: "string" } },
};

function scopePatterns(options, field) {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }
  const patterns = Reflect.get(options, field);
  if (!Array.isArray(patterns)) {
    return undefined;
  }
  return patterns.filter((pattern) => typeof pattern === "string");
}

export function isRuleFile(context, inferredScope) {
  const [options] = context.options ?? [];
  const rawFilename = context.filename ?? context.getFilename?.() ?? "";
  const filename = rawFilename.replaceAll("\\", "/");
  const cwd = context.cwd ?? context.getCwd?.() ?? process.cwd();
  const local = isAbsolute(filename)
    ? relative(cwd, filename).replaceAll("\\", "/")
    : filename;
  const matches = (pattern) =>
    matchesGlob(local, pattern) || matchesGlob(filename, pattern);
  const files = scopePatterns(options, "files");
  const excludeFiles = scopePatterns(options, "excludeFiles") ?? [];
  return (
    (files === undefined || files.some(matches)) &&
    (files !== undefined || inferredScope?.(filename) !== false) &&
    !excludeFiles.some(matches)
  );
}
