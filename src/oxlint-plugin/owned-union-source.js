import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export function astLiteralValue(node) {
  if (node?.type === "TSLiteralType") return astLiteralValue(node.literal);
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "number")
  ) {
    return node.value;
  }
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "-" &&
    typeof node.argument?.value === "number"
  ) {
    return -node.argument.value;
  }
  return null;
}

export function memberSet(values) {
  if (values.length === 0 || values.includes(null)) return null;
  return JSON.stringify(
    [...new Set(values.map((value) => JSON.stringify(value)))].sort()
  );
}

function unwrapParensAndSatisfies(node) {
  let cur = node;
  while (
    cur &&
    (cur.type === "ParenthesizedExpression" ||
      cur.type === "TSSatisfiesExpression")
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isConstAssertion(node) {
  if (node?.type !== "TSAsExpression" && node?.type !== "TSTypeAssertion") {
    return false;
  }
  const ann = node.typeAnnotation;
  return (
    ann?.type === "TSTypeReference" &&
    ann.typeName?.type === "Identifier" &&
    ann.typeName.name === "const"
  );
}

function astArrayMembers(initializer) {
  const outer = unwrapParensAndSatisfies(initializer);
  if (!isConstAssertion(outer)) return null;
  const inner = unwrapParensAndSatisfies(outer.expression);
  if (inner?.type !== "ArrayExpression") return null;
  return memberSet(inner.elements.map((element) => astLiteralValue(element)));
}

function recordConstStatement(statement, bindings, exports) {
  const isExported =
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration";
  let varDecl = null;
  if (isExported) {
    varDecl = statement.declaration;
  } else if (statement.type === "VariableDeclaration") {
    varDecl = statement;
  }
  if (!varDecl || varDecl.kind !== "const") return;
  for (const declaration of varDecl.declarations) {
    if (declaration.id?.type !== "Identifier") continue;
    const members = astArrayMembers(declaration.init);
    if (!members) continue;
    bindings.set(declaration.id.name, members);
    if (isExported) {
      exports.set(declaration.id.name, declaration.id.name);
    }
  }
}

function recordNamedExportStatement(statement, exports) {
  if (
    statement.type !== "ExportNamedDeclaration" ||
    statement.source ||
    statement.exportKind === "type"
  ) {
    return;
  }
  for (const specifier of statement.specifiers ?? []) {
    if (
      specifier.exportKind === "type" ||
      specifier.local?.type !== "Identifier"
    ) {
      continue;
    }
    const exportedName = specifier.exported?.name ?? specifier.exported?.value;
    if (typeof exportedName === "string") {
      exports.set(exportedName, specifier.local.name);
    }
  }
}

export function exportedArraysFromProgram(programNode) {
  const bindings = new Map();
  const exports = new Map();

  for (const statement of programNode?.body ?? []) {
    recordConstStatement(statement, bindings, exports);
    recordNamedExportStatement(statement, exports);
    if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration?.type === "Identifier"
    ) {
      exports.set("default", statement.declaration.name);
    }
  }

  return [...exports].flatMap(([name, local]) => {
    const members = bindings.get(local);
    return members ? [{ name, local, members }] : [];
  });
}

function stripCommentsPreserveStrings(text) {
  return text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu,
    (_full, strLiteral) => strLiteral ?? ""
  );
}

function unescapeStringLiteral(quoted) {
  const inner = quoted.slice(1, -1);
  return inner.replace(/\\(.)/gu, (_m, ch) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

function parseSingleElementToken(token) {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return unescapeStringLiteral(token);
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(token)) {
    return Number(token);
  }
  return null;
}

function parseArrayElementTokens(rawInner) {
  const tokenRegex =
    /\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s]+)\s*(?:,|$)/gu;
  const values = [];
  let consumed = 0;
  for (const match of rawInner.matchAll(tokenRegex)) {
    if (match.index !== consumed) return [null];
    consumed = match.index + match[0].length;
    values.push(parseSingleElementToken(match[1]));
  }
  if (rawInner.slice(consumed).trim().length > 0) return [null];
  return values;
}

export function exportedArrays(filename, text) {
  void filename;
  const cleaned = stripCommentsPreserveStrings(text);
  const bindings = new Map();
  const exports = new Map();

  const constRegex =
    /(?:^|[;\n])\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*\(*\s*\[([\s\S]*?)\]\s*\)*\s*as\s+const\b/gu;
  for (const match of cleaned.matchAll(constRegex)) {
    const isExported = Boolean(match[1]);
    const localName = match[2];
    const members = memberSet(parseArrayElementTokens(match[3]));
    if (!members) continue;
    bindings.set(localName, members);
    if (isExported) {
      exports.set(localName, localName);
    }
  }

  const namedExportRegex = /(?:^|[;\n])\s*export\s*\{([^}]+)\}(?!\s*from\b)/gu;
  for (const match of cleaned.matchAll(namedExportRegex)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const asMatch = trimmed.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u
      );
      if (asMatch) {
        const local = asMatch[1];
        const exported = asMatch[2] ?? local;
        exports.set(exported, local);
      }
    }
  }

  const defaultExportRegex =
    /(?:^|[;\n])\s*export\s+default\s+([A-Za-z_$][\w$]*)\b/gu;
  for (const match of cleaned.matchAll(defaultExportRegex)) {
    exports.set("default", match[1]);
  }

  return [...exports].flatMap(([name, local]) => {
    const members = bindings.get(local);
    return members ? [{ name, local, members }] : [];
  });
}

function isFile(candidate) {
  try {
    return (
      !candidate.endsWith(".d.ts") &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    );
  } catch {
    return false;
  }
}

function probeSourceFile(basePath) {
  if (isFile(basePath)) return basePath;
  const ext = extname(basePath);
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    const stem = basePath.slice(0, -ext.length);
    for (const tsExt of [".ts", ".tsx", ".mts", ".cts"]) {
      if (isFile(stem + tsExt)) return stem + tsExt;
    }
  }
  for (const candidateExt of SOURCE_EXTENSIONS) {
    if (isFile(basePath + candidateExt)) return basePath + candidateExt;
  }
  for (const candidateExt of SOURCE_EXTENSIONS) {
    const indexCandidate = join(basePath, `index${candidateExt}`);
    if (isFile(indexCandidate)) return indexCandidate;
  }
  return null;
}

function resolveSpecifierPath(filename, specifier) {
  const fromDir = dirname(filename);
  if (specifier.startsWith(".")) {
    return probeSourceFile(resolve(fromDir, specifier));
  }
  if (isAbsolute(specifier)) {
    return probeSourceFile(specifier);
  }
  if (
    specifier.startsWith("#/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/")
  ) {
    const subpath = specifier.slice(2);
    let currentDir = fromDir;
    while (true) {
      const candidate = probeSourceFile(join(currentDir, "src", subpath));
      if (candidate) return candidate;
      const rootCandidate = probeSourceFile(join(currentDir, subpath));
      if (rootCandidate) return rootCandidate;
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }
  return null;
}

export function importedArrays(filename, specifier, cache) {
  if (typeof filename !== "string" || typeof specifier !== "string") return [];
  const target = resolveSpecifierPath(filename, specifier);
  if (!target) return [];
  if (cache.has(target)) return cache.get(target);
  const text = readFileSync(target, "utf8");
  const arrays = exportedArrays(target, text);
  cache.set(target, arrays);
  return arrays;
}
