import ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import {
  aliasTarget,
  declaredInInstalledPackage,
} from "../provenance/symbol-provenance.ts";

const EFFECT_DECODE_METHODS = new Set([
  "decode",
  "decodeSync",
  "decodePromise",
  "decodeOption",
  "decodeEither",
  "decodeUnknown",
  "decodeUnknownSync",
  "decodeUnknownPromise",
  "decodeUnknownOption",
  "decodeUnknownEither",
  "decodeUnknownEffect",
  "decodeUnknownExit",
]);

function isEffectPackagePath(packagePath: string): boolean {
  return (
    packagePath === "effect" ||
    packagePath.startsWith("effect/") ||
    packagePath.startsWith("@effect/schema")
  );
}

function isEffectDecodeMethod(decoder: unknown): boolean {
  const method = identifierName(syntaxField(decoder, "property"));
  return (
    isSyntaxType(decoder, "MemberExpression") &&
    syntaxField(decoder, "computed") !== true &&
    method !== null &&
    EFFECT_DECODE_METHODS.has(method)
  );
}

function effectSchemaCall(
  schemaCall: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const tsSchemaCall = services.esTreeNodeToTSNodeMap.get(schemaCall);
  if (
    !tsSchemaCall ||
    !ts.isCallExpression(tsSchemaCall) ||
    !ts.isPropertyAccessExpression(tsSchemaCall.expression)
  ) {
    return null;
  }
  const decoderSymbol = aliasTarget(
    checker,
    checker.getSymbolAtLocation(tsSchemaCall.expression.name)
  );
  return declaredInInstalledPackage(decoderSymbol, isEffectPackagePath)
    ? tsSchemaCall
    : null;
}

export function effectDecodeCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
) {
  const callArguments = syntaxChildren(node, "arguments");
  if (!isSyntaxType(node, "CallExpression") || callArguments.length === 0) {
    return null;
  }
  const callee = syntaxField(node, "callee");
  const isCurried = isSyntaxType(callee, "CallExpression");
  const schemaCall = isCurried ? callee : node;
  const valueArgument = isCurried ? callArguments[0] : callArguments[1];
  if (
    !valueArgument ||
    syntaxChildren(schemaCall, "arguments").length === 0 ||
    !isEffectDecodeMethod(syntaxField(schemaCall, "callee"))
  ) {
    return null;
  }
  const tsSchemaCall = effectSchemaCall(schemaCall, services, checker);
  return tsSchemaCall
    ? { schemaNode: tsSchemaCall.arguments[0], valueArgument }
    : null;
}
