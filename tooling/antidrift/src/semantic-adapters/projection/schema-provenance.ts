import ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import { isInlineFunction } from "../kernel/syntax-function.ts";
import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
} from "../kernel/syntax-node.ts";
import {
  aliasTarget,
  declaredInInstalledPackage,
} from "../provenance/symbol-provenance.ts";
import { effectDecodeCallParts } from "./effect-schema.ts";

export type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";

type MemberCall = ts.CallExpression & {
  readonly expression: ts.PropertyAccessExpression;
};

export type ZodParseCallParts = {
  callee: unknown;
  tsCall: MemberCall;
  arg: unknown;
  method: string;
  returnsSchemaOutput: boolean;
};

export type SchemaValidationCallParts = {
  tsCall: ts.CallExpression;
  arg: unknown;
  schemaNode: ts.Expression | undefined;
  returnsSchemaOutput: boolean;
};

export const ZOD_PARSE_METHODS: ReadonlySet<string> = new Set([
  "parse",
  "parseAsync",
]);
export const ZOD_VALIDATION_METHODS: ReadonlySet<string> = new Set([
  ...ZOD_PARSE_METHODS,
  "safeParse",
  "safeParseAsync",
]);
export const TYPEBOX_VALIDATION_METHODS: ReadonlySet<string> = new Set([
  "Decode",
  "Parse",
  "Check",
]);
export const ZOD_TRANSFORM_METHOD = "transform";
export const ZOD_THROW_ASSERTION_MATCHERS: ReadonlySet<string> = new Set([
  "toThrow",
  "toThrowError",
]);

const THROW_MATCHER_CHAIN_TYPES = new Set([
  "CallExpression",
  "ChainExpression",
]);

function installedPackageMethod(packagePrefixes: readonly string[]) {
  const matchesPackagePath = (packagePath: string): boolean =>
    packagePrefixes.some(
      (prefix) => packagePath === prefix || packagePath.startsWith(`${prefix}/`)
    );
  return (
    checker: ts.TypeChecker,
    tsNameNode: ts.Node | null | undefined
  ): boolean =>
    declaredInInstalledPackage(
      aliasTarget(
        checker,
        tsNameNode ? checker.getSymbolAtLocation(tsNameNode) : undefined
      ),
      matchesPackagePath
    );
}

export const isZodMethod = installedPackageMethod(["zod", "@zod"]);
export const isValibotMethod = installedPackageMethod(["valibot", "@valibot"]);
export const isTypeBoxMethod = installedPackageMethod([
  "@sinclair/typebox",
  "typebox",
]);

function staticMemberName(node: unknown): string | null {
  if (
    !isSyntaxType(node, "MemberExpression") ||
    syntaxField(node, "computed") === true
  ) {
    return null;
  }
  return identifierName(syntaxField(node, "property"));
}

function isExpectCall(node: unknown): boolean {
  const callee = syntaxField(node, "callee");
  if (!isSyntaxType(node, "CallExpression")) {
    return false;
  }
  if (isSyntaxType(callee, "Identifier")) {
    return identifierName(callee) === "expect";
  }
  return (
    isSyntaxType(callee, "MemberExpression") &&
    syntaxField(callee, "computed") !== true &&
    identifierName(syntaxField(callee, "object")) === "expect"
  );
}

function isThrowMatcherCall(member: SyntaxNode): boolean {
  const parent = syntaxField(member, "parent");
  return (
    isSyntaxType(parent, "CallExpression") &&
    syntaxField(parent, "callee") === member
  );
}

function hasThrowAssertionMatcher(expectCall: unknown): boolean {
  for (
    let current = syntaxField(expectCall, "parent");
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (current.type === "MemberExpression") {
      const matcher = staticMemberName(current);
      if (matcher !== null && ZOD_THROW_ASSERTION_MATCHERS.has(matcher)) {
        return isThrowMatcherCall(current);
      }
    } else if (!THROW_MATCHER_CHAIN_TYPES.has(current.type)) {
      return false;
    }
  }
  return false;
}

function nearestFunctionExpression(node: unknown): SyntaxNode | null {
  for (
    let current = syntaxField(node, "parent");
    isSyntaxNode(current);
    current = syntaxField(current, "parent")
  ) {
    if (current.type === "FunctionDeclaration") {
      return null;
    }
    if (isInlineFunction(current)) {
      return current;
    }
  }
  return null;
}

function isDirectThrowAssertionExpression(
  node: unknown,
  callback: SyntaxNode
): boolean {
  if (syntaxField(callback, "body") === node) {
    return true;
  }
  const statement = syntaxField(node, "parent");
  const block = syntaxField(statement, "parent");
  return (
    isSyntaxType(statement, "ExpressionStatement") &&
    isSyntaxType(block, "BlockStatement") &&
    syntaxField(block, "parent") === callback
  );
}

export function isThrowAssertionCallbackParse(node: unknown): boolean {
  const callback = nearestFunctionExpression(node);
  if (!callback || !isDirectThrowAssertionExpression(node, callback)) {
    return false;
  }
  const host = syntaxField(callback, "parent");
  const expectCall =
    isSyntaxType(host, "CallExpression") &&
    syntaxChildren(host, "arguments").includes(callback)
      ? host
      : null;
  return isExpectCall(expectCall) && hasThrowAssertionMatcher(expectCall);
}

function isMemberCall(node: ts.Node | undefined): node is MemberCall {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  );
}

function staticCallMethod(node: unknown): string | null {
  return isSyntaxType(node, "CallExpression")
    ? staticMemberName(syntaxField(node, "callee"))
    : null;
}

export function zodParseCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
  methods: ReadonlySet<string> = ZOD_PARSE_METHODS
): ZodParseCallParts | null {
  const method = staticCallMethod(node);
  const [arg] = syntaxChildren(node, "arguments");
  if (method === null || !methods.has(method) || arg === undefined) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!isMemberCall(tsCall) || !isZodMethod(checker, tsCall.expression.name)) {
    return null;
  }
  return {
    callee: syntaxField(node, "callee"),
    tsCall,
    arg,
    method,
    returnsSchemaOutput: ZOD_PARSE_METHODS.has(method),
  };
}

function schemaFirstMethod(callee: unknown): string | null {
  const methodName = isSyntaxType(callee, "Identifier")
    ? identifierName(callee)
    : staticMemberName(callee);
  return methodName !== null &&
    (ZOD_VALIDATION_METHODS.has(methodName) ||
      TYPEBOX_VALIDATION_METHODS.has(methodName))
    ? methodName
    : null;
}

function schemaFirstValidationCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): SchemaValidationCallParts | null {
  const callArguments = syntaxChildren(node, "arguments");
  const methodName = isSyntaxType(node, "CallExpression")
    ? schemaFirstMethod(syntaxField(node, "callee"))
    : null;
  if (callArguments.length < 2 || methodName === null) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsCall || !ts.isCallExpression(tsCall)) {
    return null;
  }
  const tsNameNode = ts.isPropertyAccessExpression(tsCall.expression)
    ? tsCall.expression.name
    : tsCall.expression;
  const isRecognizedLibrary = ZOD_VALIDATION_METHODS.has(methodName)
    ? isValibotMethod(checker, tsNameNode)
    : isTypeBoxMethod(checker, tsNameNode);
  return isRecognizedLibrary
    ? {
        tsCall,
        arg: callArguments[1],
        schemaNode: tsCall.arguments[0],
        returnsSchemaOutput: methodName !== "Check",
      }
    : null;
}

function effectValidationCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): SchemaValidationCallParts | null | undefined {
  const effectParts = effectDecodeCallParts(node, services, checker);
  if (!effectParts) {
    return undefined;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  return tsCall && ts.isCallExpression(tsCall)
    ? {
        tsCall,
        arg: effectParts.valueArgument,
        schemaNode: effectParts.schemaNode,
        returnsSchemaOutput: true,
      }
    : null;
}

export function schemaValidationCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): SchemaValidationCallParts | null {
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
  return (
    effectValidationCallParts(node, services, checker) ??
    schemaFirstValidationCallParts(node, services, checker)
  );
}

export function zodTransformCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
) {
  const callArguments = syntaxChildren(node, "arguments");
  const [callback] = callArguments;
  if (
    staticCallMethod(node) !== ZOD_TRANSFORM_METHOD ||
    callArguments.length !== 1 ||
    !isInlineFunction(callback)
  ) {
    return null;
  }
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  return isMemberCall(tsCall) && isZodMethod(checker, tsCall.expression.name)
    ? { callee: syntaxField(node, "callee"), tsCall, callback }
    : null;
}

export function closedZodTransformInputKeys(
  receiver: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): ReadonlySet<string> | null {
  const tsReceiver = services.esTreeNodeToTSNodeMap.get(receiver);
  if (!tsReceiver) {
    return null;
  }
  const receiverType = checker.getTypeAtLocation(tsReceiver);
  const outputSymbol =
    receiverType.getSymbol()?.getName() === "ZodObject"
      ? checker.getPropertyOfType(receiverType, "_output")
      : undefined;
  if (!outputSymbol) {
    return null;
  }
  const inputType = checker.getTypeOfSymbolAtLocation(outputSymbol, tsReceiver);
  if (
    (inputType.flags & ts.TypeFlags.Object) === 0 ||
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

export function recordParsedConst(
  node: unknown,
  schemaSymbol: ts.Symbol | undefined,
  symbolOf: (node: unknown) => ts.Symbol | undefined,
  validatedBy: Map<ts.Symbol, ts.Symbol>
): void {
  const parent = syntaxField(node, "parent");
  const declarator = isSyntaxType(parent, "AwaitExpression")
    ? syntaxField(parent, "parent")
    : parent;
  const binding = syntaxField(declarator, "id");
  const declaration = syntaxField(declarator, "parent");
  if (
    !schemaSymbol ||
    !isSyntaxType(declarator, "VariableDeclarator") ||
    !isSyntaxType(binding, "Identifier") ||
    !isSyntaxType(declaration, "VariableDeclaration") ||
    syntaxText(declaration, "kind") !== "const"
  ) {
    return;
  }
  const declaredSymbol = symbolOf(binding);
  if (declaredSymbol) {
    validatedBy.set(declaredSymbol, schemaSymbol);
  }
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

function schemaExpressionOfCall(
  tsCall: ts.CallExpression,
  schemaNode: ts.Expression | undefined
): ts.Expression | undefined {
  if (schemaNode) {
    return schemaNode;
  }
  const callee = tsCall.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.expression;
  }
  return ts.isCallExpression(callee) ? callee.arguments[0] : undefined;
}

export function parsedSchemaSymbol(
  checker: ts.TypeChecker,
  tsCall: ts.CallExpression,
  schemaNode?: ts.Expression
): ts.Symbol | undefined {
  const expression = schemaExpressionOfCall(tsCall, schemaNode);
  if (!expression) {
    return undefined;
  }
  const referenced = ts.isPropertyAccessExpression(expression)
    ? expression.name
    : expression;
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(referenced));
  const declaration = symbol?.valueDeclaration;
  if (
    declaration &&
    ts.isPropertyAssignment(declaration) &&
    ts.isIdentifier(declaration.initializer)
  ) {
    return aliasTarget(
      checker,
      checker.getSymbolAtLocation(declaration.initializer)
    );
  }
  return symbol;
}

function entityNameTail(name: ts.EntityName): ts.Identifier {
  return ts.isQualifiedName(name) ? name.right : name;
}

function schemaSymbolOfOutputAlias(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode | undefined
): ts.Symbol | undefined {
  if (
    typeNode &&
    ts.isTypeQueryNode(typeNode) &&
    ts.isQualifiedName(typeNode.exprName) &&
    typeNode.exprName.right.text === "Type"
  ) {
    const owner = entityNameTail(typeNode.exprName.left);
    return aliasTarget(checker, checker.getSymbolAtLocation(owner));
  }
  if (
    !typeNode ||
    !ts.isTypeReferenceNode(typeNode) ||
    !SCHEMA_OUTPUT_TYPE_NAMES.has(entityNameTail(typeNode.typeName).text)
  ) {
    return undefined;
  }
  const [argument] = typeNode.typeArguments ?? [];
  if (!argument || !ts.isTypeQueryNode(argument)) {
    return undefined;
  }
  const reference = entityNameTail(argument.exprName);
  return aliasTarget(checker, checker.getSymbolAtLocation(reference));
}

function aliasDeclarationOfTypeNode(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode
): ts.TypeAliasDeclaration | undefined {
  if (!ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const reference = entityNameTail(typeNode.typeName);
  const symbol = aliasTarget(checker, checker.getSymbolAtLocation(reference));
  return symbol?.declarations?.find(ts.isTypeAliasDeclaration);
}

function schemaOfParameterType(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode
): ts.Symbol | undefined {
  const directSchema = schemaSymbolOfOutputAlias(checker, typeNode);
  if (directSchema) {
    return directSchema;
  }
  const alias = aliasDeclarationOfTypeNode(checker, typeNode);
  return alias && schemaSymbolOfOutputAlias(checker, alias.type);
}

export function declaredSchemaParameter(
  checker: ts.TypeChecker,
  tsArg: ts.Node
): { declaration: ts.ParameterDeclaration; schema: ts.Symbol } | undefined {
  const symbol = checker.getSymbolAtLocation(tsArg);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isParameter(declaration) && declaration.type) {
      const schema = schemaOfParameterType(checker, declaration.type);
      return schema ? { declaration, schema } : undefined;
    }
  }
  return undefined;
}
