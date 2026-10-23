import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";
import { moduleImports } from "../provenance/module-imports.ts";
import type { ModuleImports } from "../provenance/module-imports.ts";
import {
  minimumIndexedMembers,
  packageObjectTypes,
} from "./object-type-index.ts";
import type {
  ObjectMember,
  ObjectTypeDeclaration,
  ObjectTypeNode,
  PackageObjectTypes,
} from "./object-type-index.ts";
import { shapeComparison } from "./shape-identity.ts";

type ShapeVerdict = ReturnType<ReturnType<typeof shapeComparison>>;
type UnresolvedMembers = Exclude<ShapeVerdict, boolean>;

type Comparison = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sameShape: (type: ts.Type, owner: ts.Type) => ShapeVerdict;
  readonly bases: Map<ts.Node, ReadonlySet<ts.Node>>;
  readonly moduleExports: Map<ts.SourceFile, ReadonlySet<ts.Symbol>>;
  readonly memberTypes: Map<ts.TypeElement, ts.Type>;
};

type NearDuplicate = {
  readonly local: ObjectTypeDeclaration;
  readonly owner: ObjectTypeDeclaration;
  readonly shared: readonly string[];
  readonly verdict: true | UnresolvedMembers;
  readonly exact: boolean;
};

type Candidate = NearDuplicate & {
  readonly connection: number;
  readonly jaccard: number;
};

// Gate read off labelled pairs: at least three shared member names, covering
// 80% of the smaller type, with a Jaccard index of at least 0.45.
const minimumCover = 0.8;
const minimumJaccard = 0.45;
const connectionStrength = {
  moduleImport: 0,
  sameModule: 1,
  importedByName: 2,
} as const;
const comparisonByProgram = new WeakMap<ts.Program, Comparison>();

function programComparison(program: ts.Program): Comparison {
  const cached = comparisonByProgram.get(program);
  if (cached) {
    return cached;
  }
  const comparison: Comparison = {
    program,
    checker: program.getTypeChecker(),
    sameShape: shapeComparison(program),
    bases: new Map(),
    moduleExports: new Map(),
    memberTypes: new Map(),
  };
  comparisonByProgram.set(program, comparison);
  return comparison;
}

function overlapJaccard(
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration,
  shared: number
): number | undefined {
  const localSize = local.members.size;
  const ownerSize = owner.members.size;
  if (
    shared < minimumIndexedMembers ||
    shared < minimumCover * Math.min(localSize, ownerSize)
  ) {
    return undefined;
  }
  const jaccard = shared / (localSize + ownerSize - shared);
  return jaccard >= minimumJaccard ? jaccard : undefined;
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    outer.pos <= inner.pos &&
    inner.end <= outer.end
  );
}

function baseTypeDeclarations(base: ts.Type): readonly ts.Declaration[] {
  return [
    ...(base.getSymbol()?.declarations ?? []),
    ...(base.aliasSymbol?.declarations ?? []),
  ];
}

function baseDeclarations(
  comparison: Comparison,
  node: ObjectTypeNode
): ReadonlySet<ts.Node> {
  const cached = comparison.bases.get(node);
  if (cached) {
    return cached;
  }
  const { checker } = comparison;
  const found = new Set<ts.Node>();
  const symbol = ts.isInterfaceDeclaration(node)
    ? checker.getSymbolAtLocation(node.name)
    : undefined;
  const pending = symbol ? [checker.getDeclaredTypeOfSymbol(symbol)] : [];
  for (const type of pending) {
    const bases = type.isClassOrInterface() ? checker.getBaseTypes(type) : [];
    for (const base of bases) {
      const unseen = baseTypeDeclarations(base).filter(
        (declaration) => !found.has(declaration)
      );
      unseen.forEach((declaration) => found.add(declaration));
      if (unseen.length > 0) {
        pending.push(base);
      }
    }
  }
  comparison.bases.set(node, found);
  return found;
}

function related(
  comparison: Comparison,
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration
): boolean {
  const sameSymbol =
    ts.isInterfaceDeclaration(local.node) &&
    ts.isInterfaceDeclaration(owner.node) &&
    comparison.checker.getSymbolAtLocation(local.node.name) ===
      comparison.checker.getSymbolAtLocation(owner.node.name);
  return (
    sameSymbol ||
    contains(local.node, owner.node) ||
    contains(owner.node, local.node) ||
    baseDeclarations(comparison, local.node).has(owner.node) ||
    baseDeclarations(comparison, owner.node).has(local.node)
  );
}

function signatureParameter(node: ObjectTypeNode): boolean {
  if (!ts.isTypeLiteralNode(node)) {
    return false;
  }
  const signature = node.parent.parent;
  return ts.isFunctionLikeDeclaration(signature)
    ? signature.body === undefined
    : ts.isFunctionLike(signature);
}

function moduleExports(
  comparison: Comparison,
  source: ts.SourceFile
): ReadonlySet<ts.Symbol> {
  const cached = comparison.moduleExports.get(source);
  if (cached) {
    return cached;
  }
  const { checker } = comparison;
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const symbols = new Set(
    (moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []).map(
      (exportedSymbol) =>
        exportedSymbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exportedSymbol)
          : exportedSymbol
    )
  );
  comparison.moduleExports.set(source, symbols);
  return symbols;
}

function exported(comparison: Comparison, node: ObjectTypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) {
    return false;
  }
  if (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) {
    return true;
  }
  const symbol = comparison.checker.getSymbolAtLocation(node.name);
  return (
    symbol !== undefined &&
    moduleExports(comparison, node.getSourceFile()).has(symbol)
  );
}

// Within one module (or two that import each other), a named type owns a
// shape over an inline parameter type, a signature's parameter over an
// implementation's, an exported type over a private one, and an earlier
// declaration over a later one.
function ownershipRank(
  comparison: Comparison,
  declaration: ObjectTypeDeclaration
): readonly number[] {
  return [
    ts.isTypeLiteralNode(declaration.node) ? 0 : 1,
    signatureParameter(declaration.node) ? 1 : 0,
    exported(comparison, declaration.node) ? 1 : 0,
    -declaration.order,
  ];
}

function outranks(left: readonly number[], right: readonly number[]) {
  for (const [position, score] of left.entries()) {
    const other = right[position] ?? 0;
    if (score !== other) {
      return score > other;
    }
  }
  return false;
}

function importsByName(imports: ModuleImports, node: ts.Node): boolean {
  for (let current: ts.Node = node; !ts.isSourceFile(current); ) {
    if (imports.declarations.has(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// The owner is the side the other already depends on: the module that the
// local declaration's module imports, or the stronger declaration of one
// module. Declarations whose modules do not import each other are not
// connected.
function ownerConnection(
  comparison: Comparison,
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration
): number | undefined {
  const localFile = local.node.getSourceFile();
  const ownerFile = owner.node.getSourceFile();
  if (localFile === ownerFile) {
    return outranks(
      ownershipRank(comparison, owner),
      ownershipRank(comparison, local)
    )
      ? connectionStrength.sameModule
      : undefined;
  }
  const localImports = moduleImports(comparison.program, localFile);
  if (!localImports.files.has(ownerFile)) {
    return undefined;
  }
  if (
    moduleImports(comparison.program, ownerFile).files.has(localFile) &&
    !outranks(
      ownershipRank(comparison, owner),
      ownershipRank(comparison, local)
    )
  ) {
    return undefined;
  }
  return importsByName(localImports, owner.node)
    ? connectionStrength.importedByName
    : connectionStrength.moduleImport;
}

function definedParts(type: ts.Type): readonly ts.Type[] {
  if (type.isUnion()) {
    return type.types.filter(
      (part) => (part.flags & ts.TypeFlags.Undefined) === 0
    );
  }
  return (type.flags & ts.TypeFlags.Undefined) === 0 ? [type] : [];
}

// The first verdict equal to `decisive` settles the combination; otherwise
// an undecided verdict outranks the remaining non-decisive ones.
function combineVerdicts(
  verdicts: Iterable<ShapeVerdict>,
  decisive: boolean
): ShapeVerdict {
  let undecided: UnresolvedMembers | undefined;
  for (const verdict of verdicts) {
    if (verdict === decisive) {
      return decisive;
    }
    if (typeof verdict !== "boolean") {
      undecided ??= verdict;
    }
  }
  return undecided ?? !decisive;
}

function* partVerdicts(
  comparison: Comparison,
  left: readonly ts.Type[],
  right: readonly ts.Type[]
): Generator<ShapeVerdict> {
  for (const part of left) {
    yield combineVerdicts(
      right.map((candidate) => comparison.sameShape(part, candidate)),
      true
    );
  }
}

// The written type of a property, or the type of a method or accessor,
// resolved once per program and only for members a comparison reaches.
function memberType(comparison: Comparison, member: ObjectMember): ts.Type {
  const element = member.declaration;
  const cached = comparison.memberTypes.get(element);
  if (cached) {
    return cached;
  }
  const { checker } = comparison;
  let type: ts.Type;
  if (member.annotation) {
    type = checker.getTypeFromTypeNode(member.annotation);
  } else if (element.symbol) {
    type = checker.getTypeOfSymbol(element.symbol);
  } else {
    type = checker.getTypeAtLocation(element);
  }
  comparison.memberTypes.set(element, type);
  return type;
}

// Unresolved: the compiler's error type, or any reached through a written
// type reference rather than written as `any`.
function resolvedToAny(member: ObjectMember, type: ts.Type): boolean {
  return (
    isErrorType(type) ||
    ((type.flags & ts.TypeFlags.Any) !== 0 &&
      member.annotation !== undefined &&
      member.annotation.kind !== ts.SyntaxKind.AnyKeyword)
  );
}

function sameTypeParameter(left: ts.Type, right: ts.Type): boolean {
  return (
    (left.flags & right.flags & ts.TypeFlags.TypeParameter) !== 0 &&
    left.symbol.name === right.symbol.name &&
    left.getConstraint() === right.getConstraint()
  );
}

// Optionality is compared apart from the type: an optional `x?: T` and a
// required `x: T | undefined` repeat the same field type.
function sameMemberType(
  comparison: Comparison,
  left: ObjectMember,
  right: ObjectMember
): ShapeVerdict {
  const leftType = memberType(comparison, left);
  const rightType = memberType(comparison, right);
  if (resolvedToAny(left, leftType) || resolvedToAny(right, rightType)) {
    return { path: [], declarations: [] };
  }
  if (leftType === rightType || sameTypeParameter(leftType, rightType)) {
    return true;
  }
  if (left.optional || right.optional) {
    const leftParts = definedParts(leftType);
    const rightParts = definedParts(rightType);
    return leftParts.length === rightParts.length
      ? combineVerdicts(partVerdicts(comparison, leftParts, rightParts), false)
      : false;
  }
  return comparison.sameShape(leftType, rightType);
}

function compareMembers(
  comparison: Comparison,
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration,
  shared: readonly string[]
): ShapeVerdict {
  let undecided: UnresolvedMembers | undefined;
  for (const name of shared) {
    const left = local.members.get(name);
    const right = owner.members.get(name);
    const verdict =
      left && right ? sameMemberType(comparison, left, right) : false;
    if (verdict === false) {
      return false;
    }
    if (verdict !== true && left && right) {
      undecided ??= {
        path: [name, ...verdict.path],
        declarations:
          verdict.path.length > 0
            ? verdict.declarations
            : [left.declaration, right.declaration],
      };
    }
  }
  return undecided ?? true;
}

function exactCopy(
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration,
  shared: readonly string[]
): boolean {
  return (
    shared.length === local.members.size &&
    shared.length === owner.members.size &&
    shared.every(
      (name) =>
        local.members.get(name)?.optional === owner.members.get(name)?.optional
    )
  );
}

function candidate(
  comparison: Comparison,
  local: ObjectTypeDeclaration,
  owner: ObjectTypeDeclaration,
  sharedCount: number
): Candidate | undefined {
  const jaccard = overlapJaccard(local, owner, sharedCount);
  if (jaccard === undefined) {
    return undefined;
  }
  const connection = ownerConnection(comparison, local, owner);
  if (connection === undefined || related(comparison, local, owner)) {
    return undefined;
  }
  const shared = [...local.members.keys()].filter((name) =>
    owner.members.has(name)
  );
  const verdict = compareMembers(comparison, local, owner, shared);
  if (verdict === false) {
    return undefined;
  }
  return {
    local,
    owner,
    shared,
    verdict,
    exact: verdict === true && exactCopy(local, owner, shared),
    connection,
    jaccard,
  };
}

// Owner choice: decided over undecided, an exact copy over a near one, then
// the strongest connection, then the larger overlap, then the earlier owner.
function candidateRank(found: Candidate): readonly number[] {
  return [
    found.verdict === true ? 1 : 0,
    found.exact ? 1 : 0,
    found.connection,
    found.jaccard,
    -found.owner.order,
  ];
}

function bestOwner(
  comparison: Comparison,
  pkg: PackageObjectTypes,
  local: ObjectTypeDeclaration
): Candidate | undefined {
  const sharedCounts = new Map<ObjectTypeDeclaration, number>();
  for (const name of local.members.keys()) {
    for (const other of pkg.byMemberName.get(name) ?? []) {
      if (other !== local) {
        sharedCounts.set(other, (sharedCounts.get(other) ?? 0) + 1);
      }
    }
  }
  let best: Candidate | undefined;
  for (const [owner, sharedCount] of sharedCounts) {
    const found = candidate(comparison, local, owner, sharedCount);
    if (
      found &&
      (!best || outranks(candidateRank(found), candidateRank(best)))
    ) {
      best = found;
    }
  }
  return best;
}

// Object types declared in one module that repeat most of the members of an
// object type in the same package that the module could import, each with
// the one owner it should derive from.
export function nearDuplicateTypes(
  program: ts.Program,
  sourceFile: ts.SourceFile
): readonly NearDuplicate[] {
  const pkg = packageObjectTypes(program, sourceFile);
  if (!pkg) {
    return [];
  }
  const comparison = programComparison(program);
  return (pkg.byFile.get(sourceFile) ?? []).flatMap(
    (local) => bestOwner(comparison, pkg, local) ?? []
  );
}
