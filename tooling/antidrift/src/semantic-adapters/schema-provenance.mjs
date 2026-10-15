import ts from "typescript";

import { effectDecodeCallParts } from "./effect-schema.mjs";

// Methods whose call result IS the schema output, so return-type comparison is valid.
export const ZOD_PARSE_METHODS = new Set(["parse", "parseAsync"]);
// Every method that performs validation. The safe variants return a
// SafeParseReturnType wrapper rather than the schema output, so callers that
// compare the call's return type must stay on ZOD_PARSE_METHODS.
export const ZOD_VALIDATION_METHODS = new Set([
  ...ZOD_PARSE_METHODS,
  "safeParse",
  "safeParseAsync",
]);
export const TYPEBOX_VALIDATION_METHODS = new Set(["Decode", "Parse", "Check"]);
export const ZOD_TRANSFORM_METHOD = "transform";
export const ZOD_THROW_ASSERTION_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
]);

function isPackageSymbol(symbol, prefixes) {
  for (const decl of symbol?.declarations ?? []) {
    const file = decl.getSourceFile().fileName.replace(/\\/gu, "/");
    const idx = file.lastIndexOf("/node_modules/");
    if (idx === -1) continue;
    const rest = file.slice(idx + "/node_modules/".length);
    if (
      prefixes.some(
        (prefix) => rest === prefix || rest.startsWith(`${prefix}/`)
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isZodMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  return isPackageSymbol(resolvedSymbol(checker, sym), ["zod", "@zod"]);
}

export function isValibotMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  return isPackageSymbol(resolvedSymbol(checker, sym), ["valibot", "@valibot"]);
}

export function isTypeBoxMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  return isPackageSymbol(resolvedSymbol(checker, sym), [
    "@sinclair/typebox",
    "typebox",
  ]);
}

function staticMemberName(node) {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  return node.property.type === "Identifier" ? node.property.name : null;
}

function isExpectCall(node) {
  if (node?.type !== "CallExpression") return false;
  if (node.callee.type === "Identifier") return node.callee.name === "expect";
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "expect"
  );
}

function hasThrowAssertionMatcher(expectCall) {
  let current = expectCall.parent;
  while (current) {
    if (current.type === "MemberExpression") {
      if (ZOD_THROW_ASSERTION_MATCHERS.has(staticMemberName(current))) {
        return (
          current.parent?.type === "CallExpression" &&
          current.parent.callee === current
        );
      }
      current = current.parent;
      continue;
    }
    if (
      current.type === "CallExpression" ||
      current.type === "ChainExpression"
    ) {
      current = current.parent;
      continue;
    }
    break;
  }
  return false;
}

function nearestFunctionExpression(node) {
  let current = node?.parent;
  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) {
      return current;
    }
    if (current.type === "FunctionDeclaration") return null;
    current = current.parent;
  }
  return null;
}

function isDirectThrowAssertionExpression(node, fn) {
  if (fn.body === node) return true;
  return (
    node.parent?.type === "ExpressionStatement" &&
    node.parent.parent?.type === "BlockStatement" &&
    node.parent.parent.parent === fn
  );
}

export function isThrowAssertionCallbackParse(node) {
  const fn = nearestFunctionExpression(node);
  if (!fn || !isDirectThrowAssertionExpression(node, fn)) return false;
  const expectCall =
    fn.parent?.type === "CallExpression" && fn.parent.arguments.includes(fn)
      ? fn.parent
      : null;
  return Boolean(
    isExpectCall(expectCall) && hasThrowAssertionMatcher(expectCall)
  );
}

const SCHEMA_OUTPUT_TYPE_NAMES = new Set([
  "infer",
  "output",
  "TypeOf",
  "InferOutput",
  "Type",
  "Static",
  "StaticDecode",
]);

function resolvedSymbol(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function schemaExpressionOfCall(tsCall, schemaNode) {
  if (schemaNode) {
    return schemaNode;
  }
  const callee = tsCall.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.expression;
  }
  if (ts.isCallExpression(callee) && callee.arguments.length > 0) {
    return callee.arguments[0];
  }
  return undefined;
}

export function parsedSchemaSymbol(checker, tsCall, schemaNode) {
  const expression = schemaExpressionOfCall(tsCall, schemaNode);
  if (!expression) {
    return undefined;
  }
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
      checker.getSymbolAtLocation(declaration.initializer)
    );
  }
  return symbol;
}

function schemaSymbolOfOutputAlias(checker, typeNode) {
  if (!typeNode) {
    return undefined;
  }
  if (
    ts.isTypeQueryNode(typeNode) &&
    ts.isQualifiedName(typeNode.exprName) &&
    typeNode.exprName.right.text === "Type"
  ) {
    const owner = ts.isQualifiedName(typeNode.exprName.left)
      ? typeNode.exprName.left.right
      : typeNode.exprName.left;
    return resolvedSymbol(checker, checker.getSymbolAtLocation(owner));
  }
  if (!ts.isTypeReferenceNode(typeNode)) {
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
  const symbol = resolvedSymbol(
    checker,
    checker.getSymbolAtLocation(reference)
  );
  return (symbol?.declarations ?? []).find((declaration) =>
    ts.isTypeAliasDeclaration(declaration)
  );
}

export function declaredSchemaParameter(checker, tsArg) {
  const symbol = checker.getSymbolAtLocation(tsArg);
  const declaration = (symbol?.declarations ?? []).find(
    (candidate) => ts.isParameter(candidate) && candidate.type
  );
  if (!declaration) {
    return undefined;
  }
  const directSchema = schemaSymbolOfOutputAlias(checker, declaration.type);
  if (directSchema) {
    return { declaration, schema: directSchema };
  }
  const alias = aliasDeclarationOfTypeNode(checker, declaration.type);
  const schema = alias && schemaSymbolOfOutputAlias(checker, alias.type);
  return schema ? { declaration, schema } : undefined;
}

export function zodParseCallParts(
  node,
  services,
  checker,
  methods = ZOD_PARSE_METHODS
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

function schemaFirstValidationCallParts(node, services, checker) {
  if (node?.type !== "CallExpression" || node.arguments.length < 2) {
    return null;
  }
  const callee = node.callee;
  const methodName =
    callee.type === "Identifier" ? callee.name : staticMemberName(callee);
  if (
    !methodName ||
    (!ZOD_VALIDATION_METHODS.has(methodName) &&
      !TYPEBOX_VALIDATION_METHODS.has(methodName))
  ) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsCall || !ts.isCallExpression(tsCall)) return null;
  const tsNameNode = ts.isPropertyAccessExpression(tsCall.expression)
    ? tsCall.expression.name
    : tsCall.expression;
  const isRecognizedLibrary = ZOD_VALIDATION_METHODS.has(methodName)
    ? isValibotMethod(checker, tsNameNode)
    : isTypeBoxMethod(checker, tsNameNode);
  if (!isRecognizedLibrary) return null;
  return {
    tsCall,
    arg: node.arguments[1],
    schemaNode: tsCall.arguments[0],
    returnsSchemaOutput: methodName !== "Check",
  };
}

export function schemaValidationCallParts(node, services, checker) {
  const zodParts = zodParseCallParts(
    node,
    services,
    checker,
    ZOD_VALIDATION_METHODS
  );
  if (zodParts) {
    return {
      tsCall: zodParts.tsCall,
      arg: zodParts.arg,
      schemaNode: zodParts.tsCall.expression.expression,
      returnsSchemaOutput: true,
    };
  }
  const effectParts = effectDecodeCallParts(node, services, checker);
  if (effectParts) {
    const tsCall = services.esTreeNodeToTSNodeMap.get(node);
    return tsCall
      ? {
          tsCall,
          arg: effectParts.valueArg,
          schemaNode: effectParts.tsSchemaArg,
          returnsSchemaOutput: true,
        }
      : null;
  }
  return schemaFirstValidationCallParts(node, services, checker);
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
      .sort((left, right) => left.localeCompare(right))
  );
}

export function recordParsedConst(node, schemaSym, symbolOf, validatedBy) {
  let decl = node.parent;
  if (decl?.type === "AwaitExpression") decl = decl.parent;
  if (
    !schemaSym ||
    decl?.type !== "VariableDeclarator" ||
    decl.id.type !== "Identifier"
  ) {
    return;
  }
  if (
    decl.parent?.type !== "VariableDeclaration" ||
    decl.parent.kind !== "const"
  ) {
    return;
  }
  const declSym = symbolOf(decl.id);
  if (declSym) validatedBy.set(declSym, schemaSym);
}
