import type ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import { isInlineFunction } from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
} from "../kernel/syntax-node.ts";
import {
  assignmentTarget,
  collectBindingIdentifiers,
  collectBindingNames,
  hasParamRoot,
  isNullishLiteral,
  syntaxDescendants,
} from "./binding-syntax.ts";
import { isBroadShapeProbeInputType } from "./broad-input-type.ts";

export type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
export { unwrapExpression } from "../kernel/syntax-node.ts";
export {
  assignmentTarget,
  collectBindingIdentifiers,
  collectBindingNames,
  collectObjectPatternBindingNames,
  hasParamRoot,
  isBindingIdentifier,
  isNullishLiteral,
  memberExpressionPropertyName,
  memberExpressionRootName,
  staticPropertyName,
  walkNode,
} from "./binding-syntax.ts";
export {
  isAppeasementCastSourceType,
  isBroadPredicateInputType,
  isBroadShapeProbeInputType,
  isPredicateObjectContract,
  requiredTypeProps,
} from "./broad-input-type.ts";
export {
  claimedTargetVariants,
  hasValidatorDelegation,
  predicateContractEvidence,
} from "./predicate-contract.ts";
export {
  callUsesPredicateParam,
  checkedPropertyPaths,
  checkedTargetProperties,
  destructuredTargetPropertyAliases,
  directAliasName,
  objectHasOwnPropertyName,
  predicateValueNames,
} from "./predicate-paths.ts";

export type ObjectEntriesCallbackProbe = NonNullable<
  ReturnType<typeof objectEntriesCallbackProbe>
>;

export type TypePredicateParts = NonNullable<
  ReturnType<typeof typePredicateParts>
>;

export const BROAD_INPUT_ARRAY_TRANSFORM_METHODS: ReadonlySet<string> = new Set(
  ["map", "flatMap", "reduce"]
);

const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

function isEqualityComparison(node: unknown): boolean {
  const operator = syntaxText(node, "operator");
  return (
    isSyntaxType(node, "BinaryExpression") &&
    operator !== null &&
    EQUALITY_OPERATORS.has(operator)
  );
}

function isObjectTypeofLiteral(node: unknown): boolean {
  return (
    isSyntaxType(node, "Literal") && syntaxField(node, "value") === "object"
  );
}

export function isTypeofObjectProbe(
  node: unknown,
  paramNames: ReadonlySet<string>
): boolean {
  if (
    !isSyntaxType(node, "UnaryExpression") ||
    syntaxField(node, "operator") !== "typeof" ||
    !hasParamRoot(syntaxField(node, "argument"), paramNames)
  ) {
    return false;
  }
  const parent = syntaxField(node, "parent");
  if (!isEqualityComparison(parent)) {
    return false;
  }
  return syntaxField(parent, "left") === node
    ? isObjectTypeofLiteral(syntaxField(parent, "right"))
    : isObjectTypeofLiteral(syntaxField(parent, "left"));
}

function isArrayIsArrayProbe(
  node: unknown,
  paramNames: ReadonlySet<string>
): boolean {
  const callee = syntaxField(node, "callee");
  return (
    isSyntaxType(node, "CallExpression") &&
    isSyntaxType(callee, "MemberExpression") &&
    identifierName(syntaxField(callee, "object")) === "Array" &&
    identifierName(syntaxField(callee, "property")) === "isArray" &&
    hasParamRoot(syntaxChildren(node, "arguments")[0], paramNames)
  );
}

function isShapeProbe(node: unknown, paramNames: ReadonlySet<string>): boolean {
  if (isTypeofObjectProbe(node, paramNames)) {
    return true;
  }
  const left = syntaxField(node, "left");
  const right = syntaxField(node, "right");
  if (
    isSyntaxType(node, "BinaryExpression") &&
    syntaxField(node, "operator") === "in"
  ) {
    return hasParamRoot(right, paramNames);
  }
  if (isEqualityComparison(node)) {
    return (
      (hasParamRoot(left, paramNames) && isNullishLiteral(right)) ||
      (hasParamRoot(right, paramNames) && isNullishLiteral(left))
    );
  }
  return isArrayIsArrayProbe(node, paramNames);
}

export function countShapeProbesIn(
  node: unknown,
  paramNames: ReadonlySet<string>
): number {
  let count = 0;
  for (const current of syntaxDescendants(node)) {
    if (isShapeProbe(current, paramNames)) {
      count += 1;
    }
  }
  return count;
}

export function isObjectEntriesCall(node: unknown): boolean {
  const callee = syntaxField(node, "callee");
  return (
    isSyntaxType(node, "CallExpression") &&
    isSyntaxType(callee, "MemberExpression") &&
    identifierName(syntaxField(callee, "object")) === "Object" &&
    identifierName(syntaxField(callee, "property")) === "entries"
  );
}

export function objectEntriesValueBindings(
  callback: unknown,
  methodName: string
): unknown[] {
  const callbackParams = syntaxChildren(callback, "params");
  const target = assignmentTarget(
    methodName === "reduce" ? callbackParams[1] : callbackParams[0]
  );
  const bindings: unknown[] = [];
  if (isSyntaxType(target, "ArrayPattern")) {
    collectBindingIdentifiers(syntaxChildren(target, "elements")[1], bindings);
  }
  return bindings;
}

export function objectEntriesCallbackProbe(node: unknown) {
  const callee = syntaxField(node, "callee");
  const methodName = isSyntaxType(callee, "MemberExpression")
    ? identifierName(syntaxField(callee, "property"))
    : null;
  if (
    methodName === null ||
    !BROAD_INPUT_ARRAY_TRANSFORM_METHODS.has(methodName) ||
    !isObjectEntriesCall(syntaxField(callee, "object"))
  ) {
    return null;
  }
  const [callback] = syntaxChildren(node, "arguments");
  if (!isInlineFunction(callback)) {
    return null;
  }
  const paramNames = new Set<string>();
  for (const parameter of syntaxChildren(callback, "params")) {
    collectBindingNames(parameter, paramNames);
  }
  if (paramNames.size === 0) {
    return null;
  }
  return {
    callback,
    paramNames,
    valueBindings: objectEntriesValueBindings(callback, methodName),
  };
}

export function hasBroadObjectEntriesBinding(
  probe: ObjectEntriesCallbackProbe,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): boolean {
  return probe.valueBindings.some((binding) => {
    const tsNode = services.esTreeNodeToTSNodeMap.get(binding);
    return tsNode
      ? isBroadShapeProbeInputType(checker.getTypeAtLocation(tsNode))
      : false;
  });
}

export function typePredicateParts(functionNode: unknown) {
  const predicate = syntaxField(
    syntaxField(functionNode, "returnType"),
    "typeAnnotation"
  );
  const paramName = identifierName(syntaxField(predicate, "parameterName"));
  const targetTypeNode = syntaxField(
    syntaxField(predicate, "typeAnnotation"),
    "typeAnnotation"
  );
  if (
    !isSyntaxType(predicate, "TSTypePredicate") ||
    paramName === null ||
    !targetTypeNode
  ) {
    return null;
  }
  return { paramName, targetTypeNode };
}

export function functionParameterByName(functionNode: unknown, name: string) {
  return (
    syntaxChildren(functionNode, "params").find(
      (parameter) => identifierName(parameter) === name
    ) ?? null
  );
}
