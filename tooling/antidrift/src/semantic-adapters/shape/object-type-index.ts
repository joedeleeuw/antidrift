import { dirname } from "node:path";
import ts from "typescript";

import "../kernel/typescript-internals.ts";
import { packageDirectory } from "../provenance/declared-dependencies.ts";

declare module "typescript" {
  interface Node {
    readonly transformFlags?: number;
  }
}

export type ObjectTypeNode =
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.TypeLiteralNode;

export type ObjectMember = {
  readonly optional: boolean;
  readonly declaration: ts.TypeElement;
  readonly annotation: ts.TypeNode | undefined;
};

export type ObjectTypeDeclaration = {
  readonly node: ObjectTypeNode;
  readonly members: ReadonlyMap<string, ObjectMember>;
  readonly order: number;
};

export type PackageObjectTypes = {
  readonly byFile: ReadonlyMap<ts.SourceFile, ObjectTypeDeclaration[]>;
  readonly byMemberName: ReadonlyMap<string, ObjectTypeDeclaration[]>;
};

type ProgramObjectTypes = {
  readonly roots: Map<string, string | null>;
  readonly packages: Map<string, PackageObjectTypes>;
};

function internalContainsTypeScriptFlag(): number {
  const transformFlags: unknown = Reflect.get(ts, "TransformFlags");
  const flag: unknown =
    typeof transformFlags === "object" && transformFlags !== null
      ? Reflect.get(transformFlags, "ContainsTypeScript")
      : undefined;
  if (typeof flag !== "number") {
    throw new TypeError(
      `typescript ${ts.version} does not expose TransformFlags.ContainsTypeScript`
    );
  }
  return flag;
}

export const minimumIndexedMembers = 3;
// The parser marks every subtree that holds TypeScript syntax; a subtree
// without it holds no interface, type alias or typed parameter.
const containsTypeScript = internalContainsTypeScriptFlag();
const exclusionMarkers = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.UndefinedKeyword,
]);
const installedSource = /(?:^|[/\\])node_modules(?:[/\\]|$)/u;
const objectTypesByProgram = new WeakMap<ts.Program, ProgramObjectTypes>();

function packageRoot(state: ProgramObjectTypes, fileName: string) {
  const directory = dirname(fileName);
  if (!state.roots.has(directory)) {
    state.roots.set(directory, packageDirectory(fileName));
  }
  return state.roots.get(directory) ?? null;
}

function objectTypeElements(
  node: ts.Node
): readonly [ObjectTypeNode, ts.NodeArray<ts.TypeElement>] | undefined {
  if (ts.isInterfaceDeclaration(node)) {
    return [node, node.members];
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return [node, node.type.members];
  }
  if (
    ts.isTypeLiteralNode(node) &&
    ts.isParameter(node.parent) &&
    node.parent.type === node
  ) {
    return [node, node.members];
  }
  return undefined;
}

function memberName(
  checker: ts.TypeChecker,
  element: ts.TypeElement
): string | undefined {
  if (
    !ts.isPropertySignature(element) &&
    !ts.isMethodSignature(element) &&
    !ts.isGetAccessorDeclaration(element) &&
    !ts.isSetAccessorDeclaration(element)
  ) {
    return undefined;
  }
  const name = element.name;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return (element.symbol ?? checker.getSymbolAtLocation(name))?.name;
}

// Own members only: inherited members are already reused. Members written
// as never or undefined mark exclusive union arms, not fields. Member types
// are left to the comparison, which resolves only the pairs it compares.
function objectMembers(
  checker: ts.TypeChecker,
  elements: ts.NodeArray<ts.TypeElement>
): Map<string, ObjectMember> {
  const members = new Map<string, ObjectMember>();
  for (const element of elements) {
    const name = memberName(checker, element);
    const annotation = ts.isPropertySignature(element)
      ? element.type
      : undefined;
    if (
      name !== undefined &&
      !members.has(name) &&
      !(annotation && exclusionMarkers.has(annotation.kind))
    ) {
      members.set(name, {
        optional: element.questionToken !== undefined,
        declaration: element,
        annotation,
      });
    }
  }
  return members;
}

function augmentsModule(node: ts.Node): boolean {
  return (
    ts.isModuleDeclaration(node) &&
    (ts.isStringLiteral(node.name) ||
      (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0)
  );
}

function collectDeclarations(
  checker: ts.TypeChecker,
  node: ts.Node,
  declarations: ObjectTypeDeclaration[]
): void {
  if (
    augmentsModule(node) ||
    ((node.transformFlags ?? containsTypeScript) & containsTypeScript) === 0
  ) {
    return;
  }
  const found = objectTypeElements(node);
  if (found) {
    const members = objectMembers(checker, found[1]);
    if (members.size >= minimumIndexedMembers) {
      declarations.push({
        node: found[0],
        members,
        order: declarations.length,
      });
    }
  }
  ts.forEachChild(node, (child) => {
    collectDeclarations(checker, child, declarations);
  });
}

function appendDeclaration<Key>(
  groups: Map<Key, ObjectTypeDeclaration[]>,
  key: Key,
  declaration: ObjectTypeDeclaration
): void {
  const group = groups.get(key);
  if (group) {
    group.push(declaration);
  } else {
    groups.set(key, [declaration]);
  }
}

function indexPackage(
  program: ts.Program,
  state: ProgramObjectTypes,
  root: string
): PackageObjectTypes {
  const checker = program.getTypeChecker();
  const declarations: ObjectTypeDeclaration[] = [];
  for (const source of program.getSourceFiles()) {
    if (
      !source.isDeclarationFile &&
      !program.isSourceFileFromExternalLibrary(source) &&
      !installedSource.test(source.fileName) &&
      packageRoot(state, source.fileName) === root
    ) {
      collectDeclarations(checker, source, declarations);
    }
  }
  const byFile = new Map<ts.SourceFile, ObjectTypeDeclaration[]>();
  const byMemberName = new Map<string, ObjectTypeDeclaration[]>();
  for (const declaration of declarations) {
    appendDeclaration(byFile, declaration.node.getSourceFile(), declaration);
    for (const name of declaration.members.keys()) {
      appendDeclaration(byMemberName, name, declaration);
    }
  }
  return { byFile, byMemberName };
}

// The interfaces, object-literal type aliases and inline parameter object
// types of the source file's package (the nearest package.json directory) in
// this program, with at least three own members each, indexed by member name.
// Declaration files and installed dependencies are not indexed.
export function packageObjectTypes(
  program: ts.Program,
  sourceFile: ts.SourceFile
): PackageObjectTypes | null {
  let state = objectTypesByProgram.get(program);
  if (!state) {
    state = { roots: new Map(), packages: new Map() };
    objectTypesByProgram.set(program, state);
  }
  const root = packageRoot(state, sourceFile.fileName);
  if (root === null) {
    return null;
  }
  const cached = state.packages.get(root);
  if (cached) {
    return cached;
  }
  const built = indexPackage(program, state, root);
  state.packages.set(root, built);
  return built;
}
