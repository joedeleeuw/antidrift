import { dirname } from "node:path";
import ts from "typescript";

function literalValue(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

export function memberSet(values) {
  if (values.length === 0 || values.includes(null)) return null;
  return JSON.stringify(
    [...new Set(values.map((value) => JSON.stringify(value)))].sort(),
  );
}

function arrayMembers(initializer) {
  let node = initializer;
  while (
    node &&
    (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }
  if (!node || !ts.isAsExpression(node) || node.type.getText() !== "const") {
    return null;
  }
  node = node.expression;
  if (!ts.isArrayLiteralExpression(node)) return null;
  return memberSet(node.elements.map(literalValue));
}

export function exportedArrays(filename, text) {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = new Map();
  const exports = new Map();
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      const exported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const members = arrayMembers(declaration.initializer);
        if (!members) continue;
        bindings.set(declaration.name.text, members);
        if (exported) exports.set(declaration.name.text, declaration.name.text);
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const entry of statement.exportClause.elements) {
        if (!entry.isTypeOnly) {
          exports.set(entry.name.text, (entry.propertyName ?? entry.name).text);
        }
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      exports.set("default", statement.expression.text);
    }
  }
  return [...exports].flatMap(([name, local]) => {
    const members = bindings.get(local);
    return members ? [{ name, local, members }] : [];
  });
}

export function importedArrays(filename, specifier, cache) {
  const configPath = ts.findConfigFile(dirname(filename), ts.sys.fileExists);
  const config = configPath && ts.readConfigFile(configPath, ts.sys.readFile);
  const options =
    config && !config.error
      ? ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          dirname(configPath),
        ).options
      : { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const resolved = ts.resolveModuleName(
    specifier,
    filename,
    options,
    ts.sys,
  ).resolvedModule;
  if (!resolved || resolved.resolvedFileName.endsWith(".d.ts")) return [];
  const target = resolved.resolvedFileName;
  if (cache.has(target)) return cache.get(target);
  const text = ts.sys.readFile(target);
  const arrays = text === undefined ? [] : exportedArrays(target, text);
  cache.set(target, arrays);
  return arrays;
}
