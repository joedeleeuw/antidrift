import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import {
  constDeclarator,
  descendObject,
  isImportBinding,
  unwrapExpression,
} from "./canonical-path.mjs";

// Cross-module terminal identity: resolve a canonical path's root through its
// import to the defining module, collapse static segments through exported
// object literals there, and land on the terminal binding that owns the slot.
// Two paths are the same schema object when they reach the same terminal slot
// — the same (module, binding, remaining segments) tuple. Unification is by
// terminal slot after resolution, never by module specifier: two different
// exports of one module stay distinct.
//
// Every step is static — named imports, plain properties, literal keys.
// Anything dynamic (computed keys, rebuilt objects, unresolvable specifiers)
// ends resolution at the last sound tuple, and an unparseable module ends it
// at the export slot itself, which is still a sound identity. Parsing the
// defining module needs @typescript-eslint/parser (a peer of this package);
// without it resolution stops at export slots — a capability reduction, not
// an error.

const MAX_MODULE_HOPS = 6;
const PARSEABLE = /\.(?:ts|tsx|mts|jsx|js|mjs|cjs)$/u;

let parserModule;
function loadParser() {
  if (parserModule !== undefined) return parserModule;
  try {
    parserModule = createRequire(import.meta.url)("@typescript-eslint/parser");
  } catch {
    parserModule = null;
  }
  return parserModule;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

const RELATIVE_CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  "/index.ts",
  "/index.tsx",
  "/index.mjs",
  "/index.js",
];

function resolveSpecifier(specifier, fromFile) {
  if (typeof specifier !== "string" || typeof fromFile !== "string") {
    return null;
  }
  // Node's require never probes TypeScript extensions, so relative source
  // imports are resolved by direct candidate probing instead.
  if (specifier.startsWith(".")) {
    const base = resolvePath(dirname(fromFile), specifier);
    for (const suffix of RELATIVE_CANDIDATE_SUFFIXES) {
      const candidate = base + suffix;
      if (
        PARSEABLE.test(candidate) &&
        !candidate.endsWith(".d.ts") &&
        isFile(candidate)
      ) {
        return candidate;
      }
    }
    return null;
  }
  try {
    const resolved = createRequire(fromFile).resolve(specifier);
    if (!PARSEABLE.test(resolved) || resolved.endsWith(".d.ts")) return null;
    return resolved;
  } catch {
    return null;
  }
}

const moduleFactsCache = new Map();

// Top-level facts of a defining module: named imports, const initializers, and
// export aliases. Module scope only — slot resolution never needs more.
function moduleFacts(filePath) {
  if (moduleFactsCache.has(filePath)) return moduleFactsCache.get(filePath);
  let facts = null;
  const parser = loadParser();
  if (parser) {
    try {
      const program = parser.parse(readFileSync(filePath, "utf8"), {
        sourceType: "module",
        range: true,
      });
      const imports = new Map();
      const consts = new Map();
      const exportAliases = new Map();
      for (const statement of program.body) {
        collectStatement(statement, imports, consts, exportAliases);
      }
      facts = { imports, consts, exportAliases };
    } catch {
      facts = null;
    }
  }
  moduleFactsCache.set(filePath, facts);
  return facts;
}

function collectStatement(statement, imports, consts, exportAliases) {
  if (statement.type === "ImportDeclaration") {
    const specifier = statement.source?.value;
    if (typeof specifier !== "string") return;
    for (const entry of statement.specifiers ?? []) {
      if (entry.type === "ImportSpecifier") {
        const imported =
          entry.imported?.type === "Identifier"
            ? entry.imported.name
            : String(entry.imported?.value ?? "");
        imports.set(entry.local.name, { specifier, imported });
      } else if (entry.type === "ImportDefaultSpecifier") {
        imports.set(entry.local.name, { specifier, imported: "default" });
      }
    }
    return;
  }
  if (statement.type === "ExportNamedDeclaration") {
    for (const entry of statement.specifiers ?? []) {
      if (
        entry.local?.type === "Identifier" &&
        entry.exported?.type === "Identifier"
      ) {
        exportAliases.set(entry.exported.name, entry.local.name);
      }
    }
    if (statement.declaration) {
      collectStatement(statement.declaration, imports, consts, exportAliases);
    }
    return;
  }
  if (statement.type === "VariableDeclaration" && statement.kind === "const") {
    for (const declarator of statement.declarations) {
      if (declarator.id?.type === "Identifier" && declarator.init) {
        consts.set(declarator.id.name, declarator.init);
      }
    }
  }
}

function importedNameOf(variable) {
  const node = variable?.defs?.[0]?.node;
  if (node?.type === "ImportSpecifier") {
    return node.imported?.type === "Identifier"
      ? node.imported.name
      : String(node.imported?.value ?? "");
  }
  if (node?.type === "ImportDefaultSpecifier") return "default";
  return null;
}

function importSpecifierText(variable) {
  const source = variable?.defs?.[0]?.parent?.source?.value;
  return typeof source === "string" ? source : null;
}

// Rebuild a path from an initializer expression using module-level facts only:
// walk member segments to a base identifier, then classify the base.
function slotFromExpression(expression, facts, filePath) {
  const segments = [];
  let current = unwrapExpression(expression);
  while (current?.type === "MemberExpression") {
    if (current.optional === true) return null;
    let segment = null;
    if (!current.computed) {
      segment =
        current.property.type === "Identifier" ? current.property.name : null;
    } else {
      const key = unwrapExpression(current.property);
      if (
        key?.type === "Literal" &&
        (typeof key.value === "string" || typeof key.value === "number")
      ) {
        segment = String(key.value);
      }
    }
    if (segment === null) return null;
    segments.unshift(segment);
    current = unwrapExpression(current.object);
  }
  if (current?.type !== "Identifier") return null;
  const name = current.name;
  const importEntry = facts.imports.get(name);
  if (importEntry) {
    return {
      file: resolveSpecifier(importEntry.specifier, filePath),
      rawSpecifier: importEntry.specifier,
      name: importEntry.imported,
      segments,
      fromFile: filePath,
    };
  }
  if (facts.consts.has(name)) {
    return { file: filePath, name, segments, fromFile: filePath };
  }
  return null;
}

// Advance one step inside a defining module: resolve the named slot's
// initializer and either land on a deeper binding or finish.
function advanceSlot(slot) {
  if (!slot.file) return null;
  const facts = moduleFacts(slot.file);
  if (!facts) return null;
  const localName = facts.exportAliases.get(slot.name) ?? slot.name;
  const importEntry = facts.imports.get(localName);
  if (importEntry && !facts.consts.has(localName)) {
    return {
      file: resolveSpecifier(importEntry.specifier, slot.file),
      rawSpecifier: importEntry.specifier,
      name: importEntry.imported,
      segments: slot.segments,
      fromFile: slot.file,
    };
  }
  const initializer = facts.consts.get(localName);
  if (!initializer) return null;
  const unwrapped = unwrapExpression(initializer);
  if (
    unwrapped?.type === "Identifier" ||
    unwrapped?.type === "MemberExpression"
  ) {
    const next = slotFromExpression(unwrapped, facts, slot.file);
    if (!next) return null;
    return { ...next, segments: [...next.segments, ...slot.segments] };
  }
  let expression = unwrapped;
  for (let index = 0; index < slot.segments.length; index += 1) {
    const descended = descendObject(expression, slot.segments[index]);
    if (!descended) return null;
    expression = unwrapExpression(descended);
    if (expression?.type !== "Identifier") continue;
    const next = slotFromExpression(expression, facts, slot.file);
    if (!next) return null;
    return {
      ...next,
      segments: [...next.segments, ...slot.segments.slice(index + 1)],
    };
  }
  return null;
}

function slotKey(slot) {
  const moduleKey = slot.file ?? `${slot.fromFile} ${slot.rawSpecifier}`;
  return `${moduleKey} ${slot.name} ${slot.segments.join(".")}`;
}

// Terminal identity of a canonical path, or null when the root cannot be
// soundly located across the module boundary. Local const roots stay
// file-local; import roots resolve through defining modules until the walk
// can go no deeper. The returned key compares equal exactly when two paths
// read the same slot.
export function terminalIdentity(path, filename) {
  if (!path?.variable) return null;
  let slot;
  if (isImportBinding(path.variable)) {
    const specifier = importSpecifierText(path.variable);
    const name = importedNameOf(path.variable);
    if (specifier === null || name === null) return null;
    slot = {
      file: resolveSpecifier(specifier, filename),
      rawSpecifier: specifier,
      name,
      segments: path.segments,
      fromFile: filename,
    };
  } else if (constDeclarator(path.variable)) {
    slot = {
      file: filename,
      name: path.variable.name,
      segments: path.segments,
      fromFile: filename,
    };
  } else {
    return null;
  }
  const seen = new Set();
  for (let hop = 0; hop < MAX_MODULE_HOPS; hop += 1) {
    const key = slotKey(slot);
    if (seen.has(key)) return key;
    seen.add(key);
    const next = advanceSlot(slot);
    if (!next) return key;
    slot = next;
  }
  return slotKey(slot);
}

export function resetCrossModuleCacheForTests() {
  moduleFactsCache.clear();
}
