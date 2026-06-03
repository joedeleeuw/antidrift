// Minimum property count for a type to be considered a meaningful structural match.
// Below this, overlap is likely coincidental (id/name/email appear everywhere).
export const MIN_PROPS = 4;

const TS_TYPE_FLAG_OBJECT = 1 << 19; // ts.TypeFlags.Object

// Only single object/interface types are structural candidates. Unions (including string-literal
// unions like `"a" | "b"`) and intersections are excluded — a string-literal union exposes String's
// apparent members, which would spuriously match any other string-literal union.
export function isObjectType(type) {
  if (!type) return false;
  if (typeof type.isUnion === "function" && (type.isUnion() || type.isIntersection())) return false;
  return (type.flags & TS_TYPE_FLAG_OBJECT) !== 0;
}

const OPTIONAL_SUFFIX = " | undefined";

// Extract { propertyName -> resolvedTypeString } for a resolved type, skipping methods.
// Used for both the canonical side and the local side so both fingerprint identically.
export function typeProps(checker, type) {
  const props = new Map();
  for (const sym of checker.getPropertiesOfType(type)) {
    let str = checker.typeToString(checker.getTypeOfSymbol(sym));
    if (str.startsWith("(") || str.includes(" => ")) continue;
    // Optional properties surface as `T | undefined` at the top level. Strip that suffix so a
    // loosened (all-optional) redeclaration still matches the canonical required shape. Nested
    // unions like `(string | undefined)[]` end in `[]`, not the suffix, so they're unaffected.
    if (str.endsWith(OPTIONAL_SUFFIX)) str = str.slice(0, -OPTIONAL_SUFFIX.length);
    props.set(sym.name, str);
  }
  return props;
}

// Best-effort package specifier from a declaration file path. Uses the last node_modules segment
// so pnpm realpaths like `.pnpm/firebase@x/node_modules/@firebase/auth/...` yield `@firebase/auth`.
function packageOf(fileName) {
  const p = fileName.replace(/\\/gu, "/");
  const i = p.lastIndexOf("/node_modules/");
  if (i === -1) return "package";
  const parts = p.slice(i + 14).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isCanonicalSource(fileName) {
  const p = fileName.replace(/\\/gu, "/");
  // Only types shipped by installed packages count as canonical — never the user's own code.
  // The TypeScript standard libs (typescript/lib) are excluded to avoid DOM/global noise.
  return p.includes("/node_modules/") && !p.includes("/node_modules/typescript/lib/");
}

// A symbol is a named installed type when it has a real name (TypeScript prefixes synthetic
// anonymous symbols like `__type`/`__object` with `__`) and is declared in an installed package.
function isNamedInstalledSymbol(sym) {
  if (!sym) return false;
  const name = sym.getName?.() ?? sym.name;
  if (typeof name === "string" && name.startsWith("__")) return false;
  const decls = sym.getDeclarations?.() ?? sym.declarations ?? [];
  return decls.some((d) => isCanonicalSource(d.getSourceFile().fileName));
}

// True when a resolved type is a reference to (or alias of) a package's own named type — e.g.
// `type AppUser = firebase.User`, or `type Row = PrismaModel`. Such a type is not a hand-written
// fork, so it must not be flagged even though its shape matches a canonical type. Crucially, a
// `z.infer<typeof schema>` result is NOT a reference: its symbol is an anonymous `__type` from
// zod's mapped-type machinery, so the schema's hand-restated shape is still caught as drift.
export function resolvesToInstalledType(type) {
  if (!type) return false;
  const symbol = typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol;
  return isNamedInstalledSymbol(symbol) || isNamedInstalledSymbol(type.aliasSymbol);
}

function candidateFor(checker, sym, pkg) {
  let declared;
  try {
    declared = checker.getDeclaredTypeOfSymbol(sym);
  } catch {
    return null;
  }
  if (!isObjectType(declared)) return null;
  const props = typeProps(checker, declared);
  if (props.size < MIN_PROPS) return null;
  return { label: `${pkg}#${sym.getName()}`, props };
}

function exportedObjectTypes(program, checker, sourceFilter, labelFor) {
  const candidates = [];
  const seen = new Set();
  for (const sf of program.getSourceFiles()) {
    if (!sourceFilter(sf)) continue;
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) continue;
    const labelPrefix = labelFor(sf);
    for (const sym of checker.getExportsOfModule(moduleSym)) {
      const candidate = candidateFor(checker, sym, labelPrefix);
      if (candidate && !seen.has(candidate.label)) {
        seen.add(candidate.label);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

// Enumerate every exported object type (>= MIN_PROPS) from installed packages loaded in the program,
// with its property fingerprint precomputed. The program contains whatever the project imports, so
// this is fully dynamic: import a package anywhere in the codebase and its types become canonical.
export function collectCanonicalTypes(program, checker) {
  return exportedObjectTypes(
    program,
    checker,
    (sf) => sf.isDeclarationFile && isCanonicalSource(sf.fileName),
    (sf) => packageOf(sf.fileName),
  );
}

function normalizePath(fileName) {
  return fileName.replace(/\\/gu, "/");
}

function registryPath(path) {
  let source = normalizePath(path);
  while (source.startsWith("./")) source = source.slice(2);
  while (source.endsWith("/")) source = source.slice(0, -1);
  return source;
}

function matchesGeneratedSource(fileName, generated) {
  const source = registryPath(generated);
  if (!source) return false;
  const p = normalizePath(fileName);
  return p.includes(`/${source}/`) || p.endsWith(`/${source}`);
}

export function collectGeneratedCanonicalTypes(program, checker, generatedSources = {}) {
  const entries = Object.entries(generatedSources).filter(([, entry]) => typeof entry?.generated === "string");
  if (entries.length === 0) return [];
  return exportedObjectTypes(
    program,
    checker,
    (sf) => entries.some(([, entry]) => matchesGeneratedSource(sf.fileName, entry.generated)),
    (sf) => {
      const matched = entries.find(([, entry]) => matchesGeneratedSource(sf.fileName, entry.generated));
      return matched?.[0] ?? normalizePath(sf.fileName);
    },
  );
}

export function resolvesToGeneratedType(type, generatedSources = {}) {
  const entries = Object.values(generatedSources).filter((entry) => typeof entry?.generated === "string");
  if (!type || entries.length === 0) return false;
  const symbols = [typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol, type.aliasSymbol];
  return symbols.some((sym) =>
    (sym?.getDeclarations?.() ?? sym?.declarations ?? []).some((decl) =>
      entries.some((entry) => matchesGeneratedSource(decl.getSourceFile().fileName, entry.generated))
    )
  );
}

function canonicalEntityEntries(canonicalEntities = {}) {
  return Object.entries(canonicalEntities)
    .map(([name, entry]) => {
      if (typeof entry === "string") return { name, exportName: name, owner: entry };
      if (entry && typeof entry === "object" && typeof entry.owner === "string") {
        return { name, exportName: typeof entry.exportName === "string" ? entry.exportName : name, owner: entry.owner };
      }
      return null;
    })
    .filter(Boolean);
}

function matchesRegistryFile(fileName, owner) {
  const source = registryPath(owner);
  if (!source) return false;
  return normalizePath(fileName).endsWith(`/${source}`);
}

export function collectDomainCanonicalTypes(program, checker, canonicalEntities = {}) {
  const entries = canonicalEntityEntries(canonicalEntities);
  if (entries.length === 0) return [];
  const candidates = [];
  const seen = new Set();
  for (const sf of program.getSourceFiles()) {
    const matchingEntries = entries.filter((entry) => matchesRegistryFile(sf.fileName, entry.owner));
    if (matchingEntries.length === 0) continue;
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) continue;
    const exports = checker.getExportsOfModule(moduleSym);
    for (const entry of matchingEntries) {
      const sym = exports.find((candidate) => candidate.getName() === entry.exportName);
      const candidate = sym ? candidateFor(checker, sym, entry.owner) : null;
      if (!candidate || seen.has(entry.name)) continue;
      seen.add(entry.name);
      candidates.push({ ...candidate, label: `${entry.owner}#${entry.name}` });
    }
  }
  return candidates;
}

export function resolvesToDomainCanonicalType(type, canonicalEntities = {}) {
  const entries = canonicalEntityEntries(canonicalEntities);
  if (!type || entries.length === 0) return false;
  const symbols = [typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol, type.aliasSymbol];
  return symbols.some((sym) =>
    (sym?.getDeclarations?.() ?? sym?.declarations ?? []).some((decl) => {
      const sourceFile = decl.getSourceFile();
      const name = sym.getName?.() ?? sym.name;
      return entries.some((entry) => entry.exportName === name && matchesRegistryFile(sourceFile.fileName, entry.owner));
    })
  );
}
