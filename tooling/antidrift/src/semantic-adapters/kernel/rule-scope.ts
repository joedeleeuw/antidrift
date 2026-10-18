import { isAbsolute, matchesGlob, relative } from "node:path";

type RuleFileContext = {
  readonly options: readonly unknown[];
  readonly filename: string;
  readonly cwd: string;
};

export const scopeProperties = {
  files: { type: "array", items: { type: "string" } },
  excludeFiles: { type: "array", items: { type: "string" } },
};

function scopePatterns(
  options: unknown,
  field: keyof typeof scopeProperties
): readonly string[] | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }
  const patterns: unknown = Reflect.get(options, field);
  if (!Array.isArray(patterns)) {
    return undefined;
  }
  return patterns.filter((pattern) => typeof pattern === "string");
}

export function isRuleFile(context: RuleFileContext): boolean {
  const [options] = context.options;
  const filename = context.filename.replaceAll("\\", "/");
  const local = isAbsolute(filename)
    ? relative(context.cwd, filename).replaceAll("\\", "/")
    : filename;
  const matches = (pattern: string): boolean =>
    matchesGlob(local, pattern) || matchesGlob(filename, pattern);
  const files = scopePatterns(options, "files");
  const excludeFiles = scopePatterns(options, "excludeFiles") ?? [];
  return (
    (files === undefined || files.some(matches)) && !excludeFiles.some(matches)
  );
}
