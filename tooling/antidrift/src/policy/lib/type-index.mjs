import ts from "typescript";

// Minimum property count for a type to be considered a meaningful structural match.
// Below this, overlap is likely coincidental (id/name/email appear everywhere).
export const MIN_PROPS = 4;

const TS_TYPE_FLAG_OBJECT = ts.TypeFlags.Object;

// Only single object/interface types are structural candidates. Unions (including string-literal
// unions like `"a" | "b"`) and intersections are excluded — a string-literal union exposes String's
// apparent members, which would spuriously match any other string-literal union.
export function isObjectType(type) {
  if (!type) return false;
  if (
    typeof type.isUnion === "function" &&
    (type.isUnion() || type.isIntersection())
  ) {
    return false;
  }
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
    if (str.endsWith(OPTIONAL_SUFFIX)) {
      str = str.slice(0, -OPTIONAL_SUFFIX.length);
    }
    props.set(sym.name, str);
  }
  return props;
}

// Full-fidelity fingerprint: optionality, readonly, and method-ness are encoded
// per property, and the type string is NOT loosened. This is the blocking-grade
// shape; typeProps remains the loose discovery fingerprint.
export function typePropsDetailed(checker, type) {
  const props = new Map();
  for (const sym of checker.getPropertiesOfType(type)) {
    const declarations = sym.declarations ?? [];
    const method = declarations.some(
      (declaration) =>
        ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration),
    );
    const readonly = declarations.some((declaration) =>
      (ts.getModifiers(declaration) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ),
    );
    const optional = (sym.flags & ts.SymbolFlags.Optional) !== 0;
    const str = checker.typeToString(checker.getTypeOfSymbol(sym));
    props.set(sym.name, { type: str, optional, readonly, method });
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
  return (
    p.includes("/node_modules/") && !p.includes("/node_modules/typescript/lib/")
  );
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
  const symbol =
    typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol;
  return (
    isNamedInstalledSymbol(symbol) || isNamedInstalledSymbol(type.aliasSymbol)
  );
}

function candidateForType(checker, type, label, metadata = {}) {
  if (!type || !isObjectType(type)) return null;
  const props = typeProps(checker, type);
  // Discovery proposals stay at MIN_PROPS to keep coincidence noise out;
  // explicitly accepted owners are authoritative at any size, down to one
  // property, so small Convex results and arguments can be enforced.
  const minimum = metadata.authorityState === "accepted" ? 1 : MIN_PROPS;
  if (props.size < minimum) return null;
  return {
    label,
    props,
    detailedProps: typePropsDetailed(checker, type),
    ...metadata,
  };
}

function candidateFor(checker, sym, pkg, metadata = {}) {
  let declared;
  try {
    declared = checker.getDeclaredTypeOfSymbol(sym);
  } catch {
    return null;
  }
  return candidateForType(checker, declared, `${pkg}#${sym.getName()}`, metadata);

}

function exportedObjectTypes(
  program,
  checker,
  sourceFilter,
  labelFor,
  metadataFor,
) {
  const candidates = [];
  const seen = new Set();
  for (const sf of program.getSourceFiles()) {
    if (!sourceFilter(sf)) continue;
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) continue;
    const labelPrefix = labelFor(sf);
    for (const sym of checker.getExportsOfModule(moduleSym)) {
      const candidate = candidateFor(
        checker,
        sym,
        labelPrefix,
        metadataFor(sf),
      );
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
    () => ({ authority: "installed-package", authorityState: "proposal" }),
  );
}

function packageTypeOwnerEntries(packageTypeOwners = {}) {
  return Object.entries(packageTypeOwners)
    .map(([name, entry]) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      if (
        typeof entry.package !== "string" ||
        typeof entry.exportName !== "string"
      ) {
        return null;
      }
      return { name, package: entry.package, exportName: entry.exportName };
    })
    .filter(Boolean);
}

function acceptedPackageCandidate(checker, exports, entry) {
  const sym = exports.find(
    (candidate) => candidate.getName() === entry.exportName,
  );
  const candidate = sym
    ? candidateFor(checker, sym, entry.package, {
        authority: "installed-package",
        authorityState: "accepted",
        ownerKey: entry.name,
      })
    : null;
  if (!candidate) return null;
  return { ...candidate, label: `${entry.package}#${entry.exportName}` };
}

function collectAcceptedPackageCandidates(checker, exports, entries, seen) {
  const candidates = [];
  for (const entry of entries) {
    const candidate = acceptedPackageCandidate(checker, exports, entry);
    if (!candidate || seen.has(candidate.label)) continue;
    seen.add(candidate.label);
    candidates.push(candidate);
  }
  return candidates;
}

export function collectAcceptedPackageCanonicalTypes(
  program,
  checker,
  packageTypeOwners = {},
) {
  const entries = packageTypeOwnerEntries(packageTypeOwners);
  if (entries.length === 0) return [];
  const candidates = [];
  const seen = new Set();
  for (const sf of program.getSourceFiles()) {
    if (!sf.isDeclarationFile || !isCanonicalSource(sf.fileName)) continue;
    const matchingEntries = entries.filter(
      (entry) => entry.package === packageOf(sf.fileName),
    );
    if (matchingEntries.length === 0) continue;
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) continue;
    candidates.push(
      ...collectAcceptedPackageCandidates(
        checker,
        checker.getExportsOfModule(moduleSym),
        matchingEntries,
        seen,
      ),
    );
  }
  return candidates;
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

export function collectGeneratedCanonicalTypes(
  program,
  checker,
  generatedSources = {},
) {
  const entries = Object.entries(generatedSources).filter(
    ([, entry]) => typeof entry?.generated === "string",
  );
  if (entries.length === 0) return [];
  return exportedObjectTypes(
    program,
    checker,
    (sf) =>
      entries.some(([, entry]) =>
        matchesGeneratedSource(sf.fileName, entry.generated),
      ),
    (sf) => {
      const matched = entries.find(([, entry]) =>
        matchesGeneratedSource(sf.fileName, entry.generated),
      );
      return matched?.[0] ?? normalizePath(sf.fileName);
    },
    () => ({ authority: "generated-source", authorityState: "accepted" }),
  );
}

export function resolvesToGeneratedType(type, generatedSources = {}) {
  const entries = Object.values(generatedSources).filter(
    (entry) => typeof entry?.generated === "string",
  );
  if (!type || entries.length === 0) return false;
  const symbols = [
    typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol,
    type.aliasSymbol,
  ];
  return symbols.some((sym) =>
    (sym?.getDeclarations?.() ?? sym?.declarations ?? []).some((decl) =>
      entries.some((entry) =>
        matchesGeneratedSource(decl.getSourceFile().fileName, entry.generated),
      ),
    ),
  );
}

function canonicalEntityEntries(canonicalEntities = {}) {
  return Object.entries(canonicalEntities)
    .map(([name, entry]) => {
      if (typeof entry === "string") {
        return { name, exportName: name, owner: entry };
      }
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.owner === "string"
      ) {
        return {
          name,
          exportName:
            typeof entry.exportName === "string" ? entry.exportName : name,
          owner: entry.owner,
        };
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

export function collectDomainCanonicalTypes(
  program,
  checker,
  canonicalEntities = {},
) {
  const entries = canonicalEntityEntries(canonicalEntities);
  if (entries.length === 0) return [];
  const candidates = [];
  const seen = new Set();
  for (const sf of program.getSourceFiles()) {
    const matchingEntries = entries.filter((entry) =>
      matchesRegistryFile(sf.fileName, entry.owner),
    );
    if (matchingEntries.length === 0) continue;
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) continue;
    const exports = checker.getExportsOfModule(moduleSym);
    for (const entry of matchingEntries) {
      const sym = exports.find(
        (candidate) => candidate.getName() === entry.exportName,
      );
      const candidate = sym
        ? candidateFor(checker, sym, entry.owner, {
            authority: "domain",
            authorityState: "accepted",
          })
        : null;
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
  const symbols = [
    typeof type.getSymbol === "function" ? type.getSymbol() : type.symbol,
    type.aliasSymbol,
  ];
  return symbols.some((sym) =>
    (sym?.getDeclarations?.() ?? sym?.declarations ?? []).some((decl) => {
      const sourceFile = decl.getSourceFile();
      const name = sym.getName?.() ?? sym.name;
      return entries.some(
        (entry) =>
          entry.exportName === name &&
          matchesRegistryFile(sourceFile.fileName, entry.owner),
      );
    }),
  );
}

// ─── Implicit Convex generated owners ────────────────────────────────────────
// Convex codegen emits two owner modules per project: `convex/_generated/dataModel`
// (Doc<"table"> document types via the DataModel table map) and `convex/_generated/api`
// (FunctionReturnType<typeof api.*> return types via function-reference leaves). Neither
// needs registry plumbing: the module paths are fixed by the toolchain, so any program
// containing them has accepted owner authority available. Convex types carry no Zod-style
// refinements, so checker-level structural identity is sound here.

export const CONVEX_DATA_MODEL_MODULE = "convex/_generated/dataModel";
export const CONVEX_API_MODULE = "convex/_generated/api";

export function isConvexGeneratedFile(fileName) {
  const p = normalizePath(fileName);
  return p.includes("/convex/_generated/") || p.startsWith("convex/_generated/");
}

function isConvexGeneratedModule(fileName, modulePath) {
  const p = normalizePath(fileName);
  return (
    p.endsWith(`/${modulePath}.ts`) || p.endsWith(`/${modulePath}.d.ts`)
  );
}

function moduleExportSymbol(checker, sourceFile, name) {
  const moduleSym = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSym) return null;
  const sym = checker
    .getExportsOfModule(moduleSym)
    .find((candidate) => candidate.getName() === name);
  if (!sym) return null;
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

function typeOfSymbol(checker, sym) {
  try {
    return checker.getTypeOfSymbol(sym);
  } catch {
    return null;
  }
}

const convexOwnerMetadata = {
  authority: "generated-source",
  authorityState: "accepted",
};

// DataModel maps each table name to a TableInfo whose `document` property is exactly
// Doc<"table"> (convex `DocumentByName` resolves through the same path), so expanding the
// DataModel properties yields every table's document owner without enumerating references.
function convexDocCandidates(checker, sourceFile) {
  const dataModelSym = moduleExportSymbol(checker, sourceFile, "DataModel");
  if (!dataModelSym) return [];
  let dataModelType;
  try {
    dataModelType = checker.getDeclaredTypeOfSymbol(dataModelSym);
  } catch {
    return [];
  }
  const candidates = [];
  for (const tableSym of checker.getPropertiesOfType(dataModelType)) {
    const tableInfo = typeOfSymbol(checker, tableSym);
    if (!tableInfo) continue;
    const docProp = checker
      .getPropertiesOfType(tableInfo)
      .find((prop) => prop.getName() === "document");
    const docType = docProp ? typeOfSymbol(checker, docProp) : null;
    const candidate = candidateForType(
      checker,
      docType,
      `${CONVEX_DATA_MODEL_MODULE}#Doc<"${tableSym.getName()}">`,
      convexOwnerMetadata,
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

const FUNCTION_REFERENCE_RETURN_PROP = "_returnType";
const API_WALK_MAX_DEPTH = 8;

// The generated `api` object resolves to FilterApi over ApiFromModules: nested namespace
// objects whose leaves are FunctionReference-shaped (`{ _type, _args, _returnType, ... }`).
// convex `FunctionReturnType<FuncRef>` is `FuncRef["_returnType"]`, so a leaf's owner type
// is the `_returnType` property type read directly off the reference.
function collectFunctionReturnCandidates(
  checker,
  type,
  path,
  depth,
  seenTypes,
  out,
) {
  if (!type || depth <= 0 || !isObjectType(type) || seenTypes.has(type)) {
    return;
  }
  seenTypes.add(type);
  const props = checker.getPropertiesOfType(type);
  const returnProp = props.find(
    (prop) => prop.getName() === FUNCTION_REFERENCE_RETURN_PROP,
  );
  if (returnProp) {
    const candidate = candidateForType(
      checker,
      typeOfSymbol(checker, returnProp),
      `${CONVEX_API_MODULE}#FunctionReturnType<typeof api.${path}>`,
      convexOwnerMetadata,
    );
    if (candidate) out.push(candidate);
    return;
  }
  for (const prop of props) {
    if (prop.getName().startsWith("_")) continue;
    collectFunctionReturnCandidates(
      checker,
      typeOfSymbol(checker, prop),
      path ? `${path}.${prop.getName()}` : prop.getName(),
      depth - 1,
      seenTypes,
      out,
    );
  }
}

function convexApiCandidates(checker, sourceFile) {
  const apiSym = moduleExportSymbol(checker, sourceFile, "api");
  if (!apiSym) return [];
  const candidates = [];
  collectFunctionReturnCandidates(
    checker,
    typeOfSymbol(checker, apiSym),
    "",
    API_WALK_MAX_DEPTH,
    new Set(),
    candidates,
  );
  return candidates;
}

export function collectConvexGeneratedCanonicalTypes(program, checker) {
  const candidates = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const candidate of list) {
      if (seen.has(candidate.label)) continue;
      seen.add(candidate.label);
      candidates.push(candidate);
    }
  };
  for (const sf of program.getSourceFiles()) {
    if (isConvexGeneratedModule(sf.fileName, CONVEX_DATA_MODEL_MODULE)) {
      pushAll(convexDocCandidates(checker, sf));
    } else if (isConvexGeneratedModule(sf.fileName, CONVEX_API_MODULE)) {
      pushAll(convexApiCandidates(checker, sf));
    }
  }
  return candidates;
}
