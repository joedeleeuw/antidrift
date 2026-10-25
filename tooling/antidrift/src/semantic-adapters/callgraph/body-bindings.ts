import ts from "typescript";
import { LITERAL_KINDS } from "../kernel/expression-wrappers.ts";
import { targetOf } from "../provenance/package-program.ts";

export type BindingOrigin =
  | {
      readonly kind: "global";
    }
  | {
      readonly kind: "import" | "local";
      readonly declaration: ts.Declaration;
    }
  | {
      readonly kind: "module";
      readonly declaration: ts.Declaration;
      readonly statement: ts.Node;
    };
export type ParameterUse = {
  readonly node: ts.Identifier;
  readonly index: number;
  readonly shorthand: boolean;
};
export type FreeBinding = {
  readonly node: ts.Identifier;
  readonly symbol: ts.Symbol;
  readonly shorthand: boolean;
  readonly origin: BindingOrigin;
};
export type BodyBindings = {
  readonly uses: ParameterUse[];
  readonly free: FreeBinding[];
  boundLiterals: number;
  readonly hazards: string[];
  readonly unresolved: string[];
};
function consistsOfLiterals(node: ts.Node): boolean {
  if (LITERAL_KINDS.has(node.kind)) {
    return true;
  }
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return consistsOfLiterals(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return consistsOfLiterals(node.operand);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(consistsOfLiterals);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        consistsOfLiterals(property.initializer)
    );
  }
  return false;
}
function isLiteralConstant(symbol: ts.Symbol | undefined) {
  const declaration = symbol?.valueDeclaration;
  if (symbol && symbol.flags & ts.SymbolFlags.EnumMember) {
    return true;
  }
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const &&
    declaration.initializer &&
    consistsOfLiterals(declaration.initializer)
  );
}
function moduleLevel(declaration: ts.Declaration, sourceFile: ts.SourceFile) {
  let statement: ts.Node = declaration;
  if (ts.isVariableDeclaration(statement)) {
    statement = statement.parent.parent;
  }
  return statement.parent === sourceFile ? statement : null;
}
function originOf(symbol: ts.Symbol, sourceFile: ts.SourceFile): BindingOrigin {
  const declaration = symbol.declarations?.[0];
  if (
    !declaration ||
    declaration.getSourceFile() !== sourceFile ||
    !ts.isExternalModule(sourceFile)
  ) {
    return { kind: "global" };
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return { kind: "import", declaration };
  }
  const statement = moduleLevel(declaration, sourceFile);
  return statement
    ? { kind: "module", declaration, statement }
    : { kind: "local", declaration };
}
export function bodyBindings(
  program: ts.Program,
  functionNode: ts.SignatureDeclaration,
  body: ts.Expression
) {
  const checker = program.getTypeChecker();
  const sourceFile = body.getSourceFile();
  const parameterSymbols = functionNode.parameters.map((parameter) =>
    checker.getSymbolAtLocation(parameter.name)
  );
  const bindings: BodyBindings = {
    uses: [],
    free: [],
    boundLiterals: 0,
    hazards: [],
    unresolved: [],
  };
  function record(
    identifier: ts.Identifier,
    symbol: ts.Symbol | undefined,
    shorthand: boolean
  ) {
    const index = parameterSymbols.indexOf(symbol);
    if (index >= 0) {
      bindings.uses.push({ node: identifier, index, shorthand });
    } else if (!symbol) {
      bindings.unresolved.push(`the name ${identifier.text} does not resolve`);
    } else if (identifier.text === "arguments" && !symbol.declarations) {
      bindings.hazards.push("reads the arguments object");
    } else {
      const origin = originOf(symbol, sourceFile);
      bindings.free.push({ node: identifier, symbol, shorthand, origin });
      if (isLiteralConstant(targetOf(checker, symbol))) {
        bindings.boundLiterals++;
      }
    }
  }
  function visit(node: ts.Node) {
    if (LITERAL_KINDS.has(node.kind)) {
      bindings.boundLiterals++;
    }
    if (ts.isIdentifier(node)) {
      record(node, checker.getSymbolAtLocation(node), false);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      record(node.name, checker.getShorthandAssignmentValueSymbol(node), true);
    } else if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
    } else if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) {
        visit(node.name);
      }
      visit(node.initializer);
    } else {
      ts.forEachChild(node, visit);
    }
  }
  visit(body);
  return bindings;
}
export function bindingAtSite(
  program: ts.Program,
  free: FreeBinding,
  site: ts.Node
) {
  const checker = program.getTypeChecker();
  const visible = checker.resolveName(
    free.node.text,
    site,
    ts.SymbolFlags.Value,
    false
  );
  if (!visible) {
    return "absent";
  }
  return targetOf(checker, visible) === targetOf(checker, free.symbol)
    ? "same"
    : "other";
}
export function importOfFile(
  program: ts.Program,
  siteFile: ts.SourceFile,
  targetFile: ts.SourceFile
) {
  const checker = program.getTypeChecker();
  return siteFile.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      checker.getSymbolAtLocation(statement.moduleSpecifier)
        ?.valueDeclaration === targetFile
  );
}
