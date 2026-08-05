import ts from "typescript";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;

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
export const ZOD_THROW_ASSERTION_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
]);

function isAnyOrUnknownType(type) {
  return Boolean(
    type && type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN),
  );
}

function typeContainsAnyOrUnknown(checker, type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (isAnyOrUnknownType(type)) return true;
  for (const part of type.types ?? []) {
    if (typeContainsAnyOrUnknown(checker, part, seen)) return true;
  }
  const stringIndexType = type.getStringIndexType?.();
  if (typeContainsAnyOrUnknown(checker, stringIndexType, seen)) return true;
  const numberIndexType = type.getNumberIndexType?.();
  if (typeContainsAnyOrUnknown(checker, numberIndexType, seen)) return true;
  for (const property of checker.getPropertiesOfType(type)) {
    if (typeContainsAnyOrUnknown(checker, checker.getTypeOfSymbol(property), seen)) {
      return true;
    }
  }
  return false;
}

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
    isExpectCall(expectCall) && hasThrowAssertionMatcher(expectCall),
  );
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

export function isAwaitedCallInitializer(node) {
  return (
    node?.type === "AwaitExpression" && node.argument?.type === "CallExpression"
  );
}

export function isCallResultExpression(node) {
  return node?.type === "CallExpression" || isAwaitedCallInitializer(node);
}

export function isZodParseExpression(node, services, checker) {
  if (node?.type === "CallExpression") {
    return Boolean(zodParseCallParts(node, services, checker));
  }
  if (
    node?.type === "AwaitExpression" &&
    node.argument?.type === "CallExpression"
  ) {
    return Boolean(zodParseCallParts(node.argument, services, checker));
  }
  return false;
}

export function parsedCallResultMatchesSchemaOutput(
  checker,
  services,
  tsCall,
  arg,
) {
  const tsArg = services.esTreeNodeToTSNodeMap.get(arg);
  const argType = tsArg ? checker.getTypeAtLocation(tsArg) : null;
  const parseReturnType = checker.getTypeAtLocation(tsCall);
  return Boolean(
    argType &&
    !isAnyOrUnknownType(argType) &&
    !isAnyOrUnknownType(parseReturnType) &&
    !typeContainsAnyOrUnknown(checker, parseReturnType) &&
    checker.isTypeAssignableTo(argType, parseReturnType) &&
    checker.isTypeAssignableTo(parseReturnType, argType),
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
