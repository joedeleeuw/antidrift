import { matchesGlob, relative, isAbsolute } from "node:path";

export const scopeProperties = {
  files: { type: "array", items: { type: "string" } },
  excludeFiles: { type: "array", items: { type: "string" } },
};

export function isRuleFile(context) {
  const options = context.options[0] ?? {};
  const filename = (context.filename ?? context.getFilename()).replaceAll(
    "\\",
    "/",
  );
  const cwd = context.cwd ?? process.cwd();
  const local = isAbsolute(filename)
    ? relative(cwd, filename).replaceAll("\\", "/")
    : filename;
  const matches = (pattern) =>
    matchesGlob(local, pattern) || matchesGlob(filename, pattern);
  return (
    (options.files === undefined || options.files.some(matches)) &&
    !(options.excludeFiles ?? []).some(matches)
  );
}
