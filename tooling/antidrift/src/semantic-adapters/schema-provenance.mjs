import ts from "typescript";

import {
  ZOD_PARSE_METHODS,
  ZOD_TRANSFORM_METHOD,
} from "./schema-parse-shape.mjs";

// Method sets and the throw-assertion-context test live in the syntax tier so
// the Oxlint plugin can use them without loading the TypeScript compiler; they
// are re-exported here to keep this adapter's import surface stable.
export {
  isThrowAssertionCallbackParse,
  ZOD_PARSE_METHODS,
  ZOD_THROW_ASSERTION_MATCHERS,
  ZOD_TRANSFORM_METHOD,
  ZOD_VALIDATION_METHODS,
} from "./schema-parse-shape.mjs";

export function isZodMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  for (const decl of sym?.declarations ?? []) {
    const file = decl.getSourceFile().fileName.replace(/\\/gu, "/");
    const idx = file.lastIndexOf("/node_modules/");
    if (idx === -1) continue;
    const rest = file.slice(idx + "/node_modules/".length);
    if (rest === "zod" || rest.startsWith("zod/") || rest.startsWith("@zod/")) {
      return true;
    }
  }
  return false;
}

// ── Schema-derivation trace: resolve a declared type alias back to the
// z.infer/z.output schema it descends from, and the schema receiving a parse. ──
const SCHEMA_OUTPUT_TYPE_NAMES = new Set(["infer", "output", "TypeOf"]);

function resolvedSymbol(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function symbolForExpression(checker, expression) {
  const node = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
  const declaration = symbol?.valueDeclaration;
  if (
    declaration &&
    ts.isPropertyAssignment(declaration) &&
    ts.isIdentifier(declaration.initializer)
  ) {
    return resolvedSymbol(
      checker,
      checker.getSymbolAtLocation(declaration.initializer),
    );
  }
  return symbol;
}

export function parsedSchemaSymbol(checker, tsCall) {
  const callee = tsCall.expression;
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  return symbolForExpression(checker, callee.expression);
}

// `z.infer<typeof S>` / `z.output<typeof S>` — the schema the alias was derived from.
function schemaSymbolOfOutputAlias(checker, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const name = typeNode.typeName;
  const memberName = ts.isQualifiedName(name) ? name.right.text : name.text;
  if (!SCHEMA_OUTPUT_TYPE_NAMES.has(memberName)) {
    return undefined;
  }
  const [argument] = typeNode.typeArguments ?? [];
  if (!argument || !ts.isTypeQueryNode(argument)) {
    return undefined;
  }
  const reference = ts.isQualifiedName(argument.exprName)
    ? argument.exprName.right
    : argument.exprName;
  return resolvedSymbol(checker, checker.getSymbolAtLocation(reference));
}

function aliasDeclarationOfTypeNode(checker, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const reference = ts.isQualifiedName(typeNode.typeName)
    ? typeNode.typeName.right
    : typeNode.typeName;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(reference));
  return (symbol?.declarations ?? []).find((declaration) =>
    ts.isTypeAliasDeclaration(declaration),
  );
}

export function declaredSchemaSymbolOfParameter(checker, tsArg) {
  const symbol = checker.getSymbolAtLocation(tsArg);
  const parameter = (symbol?.declarations ?? []).find(
    (declaration) => ts.isParameter(declaration) && declaration.type,
  );
  if (!parameter) {
    return undefined;
  }
  const alias = aliasDeclarationOfTypeNode(checker, parameter.type);
  return alias && schemaSymbolOfOutputAlias(checker, alias.type);
}


export function zodParseCallParts(
  node,
  services,
  checker,
  methods = ZOD_PARSE_METHODS,
) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  if (
    callee.property.type !== "Identifier" ||
    !methods.has(callee.property.name)
  ) {
    return null;
  }
  if (node.arguments.length === 0) return null;
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!isZodMethod(checker, tsCall?.expression?.name)) return null;
  return {
    callee,
    tsCall,
    arg: node.arguments[0],
    method: callee.property.name,
    returnsSchemaOutput: ZOD_PARSE_METHODS.has(callee.property.name),
  };
}

export function zodTransformCallParts(node, services, checker) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== ZOD_TRANSFORM_METHOD
  ) {
    return null;
  }
  const callback = node.arguments[0];
  if (
    node.arguments.length !== 1 ||
    (callback?.type !== "ArrowFunctionExpression" &&
      callback?.type !== "FunctionExpression")
  ) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!isZodMethod(checker, tsCall?.expression?.name)) return null;
  return { callee, tsCall, callback };
}

export function closedZodTransformInputKeys(receiver, services, checker) {
  const tsReceiver = services.esTreeNodeToTSNodeMap.get(receiver);
  if (!tsReceiver) return null;
  const receiverType = checker.getTypeAtLocation(tsReceiver);
  if (receiverType.getSymbol()?.getName() !== "ZodObject") return null;
  const outputSymbol = checker.getPropertyOfType(receiverType, "_output");
  if (!outputSymbol) return null;
  const inputType = checker.getTypeOfSymbolAtLocation(outputSymbol, tsReceiver);
  if ((inputType.flags & ts.TypeFlags.Object) === 0) return null;
  if (
    checker.getIndexTypeOfType(inputType, ts.IndexKind.String) ||
    checker.getIndexTypeOfType(inputType, ts.IndexKind.Number)
  ) {
    return null;
  }
  return new Set(
    checker
      .getPropertiesOfType(inputType)
      .map((property) => property.getName())
      .sort((left, right) => left.localeCompare(right)),
  );
}
