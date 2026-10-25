import ts from "typescript";

export type ContractSite =
  | ts.CallExpression
  | ts.Identifier
  | ts.PropertyAccessExpression;

export type LocalContractScope = {
  readonly declarations: ReadonlyMap<ts.Node, ReadonlyMap<string, ts.Type>>;
};

export function contractScopeKey(
  filePaths: readonly string[],
  localContracts: LocalContractScope
): string {
  return JSON.stringify({
    filePaths: [...filePaths].sort(),
    declarations: [...localContracts.declarations]
      .map(([node, fields]) => ({
        node: `${node.getSourceFile().fileName}:${node.pos}:${node.end}`,
        fields: [...fields.keys()].sort(),
      }))
      .sort((left, right) => left.node.localeCompare(right.node)),
  });
}

function isCallee(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === node
  );
}

function isNameOnly(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    ("name" in parent &&
      parent.name === identifier &&
      !ts.isShorthandPropertyAssignment(parent)) ||
    ts.isQualifiedName(parent)
  );
}

export function isProjectSource(file: ts.SourceFile): boolean {
  return !file.isDeclarationFile && !file.fileName.includes("/node_modules/");
}

export function collectContractSites(
  node: ts.Node,
  sites: ContractSite[]
): void {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isTypeNode(node) ||
    ts.isImportDeclaration(node)
  ) {
    return;
  }
  if (ts.isCallExpression(node)) {
    sites.push(node);
  } else if (ts.isIdentifier(node)) {
    if (!isNameOnly(node) && !isCallee(node)) {
      sites.push(node);
    }
  } else if (ts.isPropertyAccessExpression(node) && !isCallee(node)) {
    sites.push(node);
  }
  ts.forEachChild(node, (child) => {
    collectContractSites(child, sites);
  });
}
