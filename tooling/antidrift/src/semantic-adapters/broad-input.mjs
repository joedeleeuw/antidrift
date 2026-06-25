import ts from "typescript";

import { callExpressionName } from "./auth-boundary.mjs";
import { isZodMethod } from "./schema-provenance.mjs";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;
const TS_TYPE_FLAG_OBJECT = 1 << 19;
const antidriftBrandMarkerName = "__antidriftBrand";
const ZOD_VALIDATOR_METHODS = new Set(["parse", "parseAsync", "safeParse"]);

export const BROAD_INPUT_ARRAY_TRANSFORM_METHODS = new Set([
  "map",
  "flatMap",
  "reduce",
]);

export function unwrapExpression(expression) {
  if (expression?.type === "ChainExpression") return expression.expression;
  if (expression?.type === "TSAsExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSNonNullExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSSatisfiesExpression") {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

export function assignmentTarget(node) {
  return node?.type === "AssignmentPattern" ? node.left : node;
}

export function collectBindingNames(node, names) {
  const target = assignmentTarget(node);
  if (!target) return;
  if (target.type === "Identifier") {
    names.add(target.name);
    return;
  }
  if (target.type === "RestElement") {
    collectBindingNames(target.argument, names);
    return;
  }
  if (target.type === "ArrayPattern") {
    for (const element of target.elements ?? []) {
      collectBindingNames(element, names);
    }
    return;
  }
  if (target.type === "ObjectPattern") {
    collectObjectPatternBindingNames(target, names);
  }
}

function bindingIdentifierName(node) {
  const target = assignmentTarget(node);
  return target?.type === "Identifier" ? target.name : null;
}

function nestedObjectPattern(node) {
  const target = assignmentTarget(node);
  return target?.type === "ObjectPattern" ? target : null;
}

export function collectObjectPatternBindingNames(pattern, names) {
  for (const property of pattern.properties ?? []) {
    const name =
      property.type === "RestElement"
        ? bindingIdentifierName(property.argument)
        : bindingIdentifierName(property.value);
    if (name) names.add(name);
    const nested =
      property.type === "Property" ? nestedObjectPattern(property.value) : null;
    if (nested) collectObjectPatternBindingNames(nested, names);
  }
}

export function collectBindingIdentifiers(node, identifiers) {
  const target = assignmentTarget(node);
  if (!target) return;
  if (target.type === "Identifier") {
    identifiers.push(target);
    return;
  }
  if (target.type === "RestElement") {
    collectBindingIdentifiers(target.argument, identifiers);
    return;
  }
  if (target.type === "ArrayPattern") {
    for (const element of target.elements ?? []) {
      collectBindingIdentifiers(element, identifiers);
    }
    return;
  }
  if (target.type === "ObjectPattern") {
    for (const property of target.properties ?? []) {
      collectBindingIdentifiers(
        property.type === "RestElement" ? property.argument : property.value,
        identifiers,
      );
    }
  }
}

export function memberExpressionRootName(expression) {
  let cur = unwrapExpression(expression);
  while (cur?.type === "MemberExpression") cur = unwrapExpression(cur.object);
  return cur?.type === "Identifier" ? cur.name : null;
}

export function walkNode(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkNode(child, visit);
    } else if (value && typeof value.type === "string") {
      walkNode(value, visit);
    }
  }
}

export function isNullishLiteral(node) {
  return (
    (node?.type === "Literal" && node.value === null) ||
    (node?.type === "Identifier" && node.name === "undefined")
  );
}

export function hasParamRoot(expression, paramNames) {
  const root = memberExpressionRootName(expression);
  return Boolean(root && paramNames.has(root));
}

function isObjectLiteral(node) {
  return node?.type === "Literal" && node.value === "object";
}

export function isTypeofObjectProbe(node, paramNames) {
  if (
    node?.type !== "UnaryExpression" ||
    node.operator !== "typeof" ||
    !hasParamRoot(node.argument, paramNames)
  ) {
    return false;
  }
  const parent = node.parent;
  if (
    parent?.type !== "BinaryExpression" ||
    !["==", "===", "!=", "!=="].includes(parent.operator)
  ) {
    return false;
  }
  return parent.left === node
    ? isObjectLiteral(parent.right)
    : isObjectLiteral(parent.left);
}

export function countShapeProbesIn(node, paramNames) {
  let count = 0;
  walkNode(node, (current) => {
    if (isTypeofObjectProbe(current, paramNames)) {
      count += 1;
      return;
    }
    if (
      current.type === "BinaryExpression" &&
      current.operator === "in" &&
      hasParamRoot(current.right, paramNames)
    ) {
      count += 1;
      return;
    }
    if (
      current.type === "BinaryExpression" &&
      ["==", "===", "!=", "!=="].includes(current.operator)
    ) {
      const leftIsProbe =
        hasParamRoot(current.left, paramNames) &&
        isNullishLiteral(current.right);
      const rightIsProbe =
        hasParamRoot(current.right, paramNames) &&
        isNullishLiteral(current.left);
      if (leftIsProbe || rightIsProbe) count += 1;
      return;
    }
    if (
      current.type === "CallExpression" &&
      current.callee?.type === "MemberExpression" &&
      current.callee.object?.type === "Identifier" &&
      current.callee.object.name === "Array" &&
      current.callee.property?.type === "Identifier" &&
      current.callee.property.name === "isArray" &&
      hasParamRoot(current.arguments?.[0], paramNames)
    ) {
      count += 1;
    }
  });
  return count;
}

export function isObjectEntriesCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Object" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "entries"
  );
}

export function objectEntriesValueBindings(callback, methodName) {
  const entryParam =
    methodName === "reduce" ? callback.params?.[1] : callback.params?.[0];
  const target = assignmentTarget(entryParam);
  const bindings = [];
  if (target?.type === "ArrayPattern") {
    collectBindingIdentifiers(target.elements?.[1], bindings);
  }
  return bindings;
}

export function objectEntriesCallbackProbe(node) {
  const callee = node?.callee;
  if (
    callee?.type !== "MemberExpression" ||
    callee.property?.type !== "Identifier"
  ) {
    return null;
  }
  const methodName = callee.property.name;
  if (!BROAD_INPUT_ARRAY_TRANSFORM_METHODS.has(methodName)) return null;
  if (!isObjectEntriesCall(callee.object)) return null;
  const cb = node.arguments?.[0];
  if (
    cb?.type !== "ArrowFunctionExpression" &&
    cb?.type !== "FunctionExpression"
  ) {
    return null;
  }
  const names = new Set();
  for (const param of cb.params ?? []) collectBindingNames(param, names);
  if (names.size === 0) return null;
  return {
    callback: cb,
    paramNames: names,
    valueBindings: objectEntriesValueBindings(cb, methodName),
  };
}

function isAnyOrUnknownType(type) {
  return Boolean(
    type && type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN),
  );
}

export function isBroadShapeProbeInputType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (isAnyOrUnknownType(type)) return true;
  return (type.types ?? []).some((part) =>
    isBroadShapeProbeInputType(part, seen),
  );
}

export function hasBroadObjectEntriesValue(probe, services, checker) {
  return probe.valueBindings.some((binding) => {
    const tsNode = services.esTreeNodeToTSNodeMap.get(binding);
    return tsNode
      ? isBroadShapeProbeInputType(checker.getTypeAtLocation(tsNode))
      : false;
  });
}

export function typePredicateParts(fn) {
  const predicate = fn?.returnType?.typeAnnotation;
  if (predicate?.type !== "TSTypePredicate") return null;
  if (predicate.parameterName?.type !== "Identifier") return null;
  const targetTypeNode = predicate.typeAnnotation?.typeAnnotation;
  if (!targetTypeNode) return null;
  return { paramName: predicate.parameterName.name, targetTypeNode };
}

export function functionParameterByName(fn, name) {
  return (
    (fn.params ?? []).find(
      (param) => param?.type === "Identifier" && param.name === name,
    ) ?? null
  );
}

export function isBroadPredicateInputType(checker, type) {
  if (isAnyOrUnknownType(type)) return true;
  const stringIndexType = type.getStringIndexType?.();
  if (isAnyOrUnknownType(stringIndexType)) return true;
  const numberIndexType = type.getNumberIndexType?.();
  if (isAnyOrUnknownType(numberIndexType)) return true;
  return (
    (type.flags & TS_TYPE_FLAG_OBJECT) !== 0 &&
    checker.getPropertiesOfType(type).length === 0
  );
}

function isAntidriftBrandMarkerProperty(prop) {
  for (const decl of prop.declarations ?? []) {
    const name = decl.name;
    const sourceFile =
      decl.getSourceFile?.().fileName.replace(/\\/gu, "/") ?? "";
    const isAntidriftDeclaration =
      sourceFile.endsWith("@joedeleeuw/antidrift/src/brand/index.d.mts") ||
      sourceFile.endsWith("tooling/antidrift/src/brand/index.d.mts");
    if (!isAntidriftDeclaration) continue;
    if (name?.getText?.() === `[${antidriftBrandMarkerName}]`) return true;
  }
  return false;
}

function isAntidriftBrandedType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if ((type.getProperties?.() ?? []).some(isAntidriftBrandMarkerProperty)) {
    return true;
  }
  return (type.types ?? []).some((part) => isAntidriftBrandedType(part, seen));
}

export function isNamedTypeReference(typeNode) {
  return typeNode?.type === "TSTypeReference";
}

export function isAppeasementCastSourceType(type) {
  return isAnyOrUnknownType(type);
}

export function isAppeasementCastTargetType(type) {
  if (isAntidriftBrandedType(type)) return false;
  return (type?.getProperties?.() ?? []).length > 0;
}

export function isAppeasementContractCast(node, services, checker) {
  if (!isNamedTypeReference(node?.typeAnnotation)) return false;
  if (
    node.expression?.type === "TSAsExpression" &&
    node.expression.typeAnnotation?.type === "TSUnknownKeyword"
  ) {
    return false;
  }

  const tsExpression = services.esTreeNodeToTSNodeMap.get(node.expression);
  const tsTypeNode = services.esTreeNodeToTSNodeMap.get(node.typeAnnotation);
  if (!tsExpression || !tsTypeNode) return false;

  return (
    isAppeasementCastSourceType(checker.getTypeAtLocation(tsExpression)) &&
    isAppeasementCastTargetType(checker.getTypeFromTypeNode(tsTypeNode))
  );
}

export function isPredicateObjectContract(type) {
  if (!type) return false;
  if (typeof type.isUnion === "function" && type.isUnion()) return false;
  if (typeof type.isIntersection === "function" && type.isIntersection()) {
    return (type.types ?? []).some((part) => isPredicateObjectContract(part));
  }
  return (type.flags & TS_TYPE_FLAG_OBJECT) !== 0;
}

export function requiredTypeProps(checker, type) {
  const props = new Set();
  for (const sym of checker.getPropertiesOfType(type)) {
    if ((sym.flags & ts.SymbolFlags.Optional) !== 0) continue;
    const propertyType = checker.getTypeOfSymbol(sym);
    if ((propertyType.getCallSignatures?.() ?? []).length > 0) continue;
    props.add(sym.name);
  }
  return props;
}

export function staticPropertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "PrivateIdentifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

export function memberExpressionPropertyName(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type !== "MemberExpression") return null;
  return staticPropertyName(unwrapped.property);
}

export function objectHasOwnPropertyName(node, paramNames) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression") return null;
  const method = staticPropertyName(callee.property);
  if (method !== "hasOwn" && method !== "hasOwnProperty") return null;
  if (callee.object?.type === "Identifier" && callee.object.name === "Object") {
    return hasParamRoot(node.arguments?.[0], paramNames)
      ? staticPropertyName(node.arguments?.[1])
      : null;
  }
  return hasParamRoot(callee.object, paramNames)
    ? staticPropertyName(node.arguments?.[0])
    : null;
}

export function directAliasName(node, paramNames) {
  if (node?.type !== "VariableDeclarator" || node.id?.type !== "Identifier") {
    return null;
  }
  const init = unwrapExpression(node.init);
  return init?.type === "Identifier" && paramNames.has(init.name)
    ? node.id.name
    : null;
}

export function predicateValueNames(node, paramName) {
  const names = new Set([paramName]);
  let changed = true;
  while (changed) {
    changed = false;
    walkNode(node, (current) => {
      const alias = directAliasName(current, names);
      if (alias && !names.has(alias)) {
        names.add(alias);
        changed = true;
      }
    });
  }
  return names;
}

export function destructuredTargetPropertyAliases(
  node,
  paramNames,
  targetProps,
) {
  const aliases = new Map();
  walkNode(node, (current) => {
    if (
      current.type !== "VariableDeclarator" ||
      current.id?.type !== "ObjectPattern"
    ) {
      return;
    }
    if (!hasParamRoot(current.init, paramNames)) return;
    for (const prop of current.id.properties ?? []) {
      if (prop?.type !== "Property") continue;
      const propName = staticPropertyName(prop.key);
      if (!targetProps.has(propName)) continue;
      const value =
        prop.value?.type === "AssignmentPattern" ? prop.value.left : prop.value;
      if (value?.type === "Identifier") aliases.set(value.name, propName);
    }
  });
  return aliases;
}

export function isBindingIdentifier(node) {
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id === node) return true;
  if (
    parent?.type === "Property" &&
    parent.value === node &&
    parent.parent?.type === "ObjectPattern"
  ) {
    return true;
  }
  if (
    parent?.type === "AssignmentPattern" &&
    parent.left === node &&
    parent.parent?.type === "Property"
  ) {
    return true;
  }
  return false;
}

export function checkedTargetProperties(node, paramName, targetProps) {
  const checked = new Set();
  const paramNames = predicateValueNames(node, paramName);
  const propertyAliases = destructuredTargetPropertyAliases(
    node,
    paramNames,
    targetProps,
  );
  walkNode(node, (current) => {
    if (
      current.type === "BinaryExpression" &&
      current.operator === "in" &&
      hasParamRoot(current.right, paramNames)
    ) {
      const prop = staticPropertyName(current.left);
      if (targetProps.has(prop)) checked.add(prop);
      return;
    }
    const hasOwnProp = objectHasOwnPropertyName(current, paramNames);
    if (targetProps.has(hasOwnProp)) {
      checked.add(hasOwnProp);
      return;
    }
    if (
      current.type === "MemberExpression" &&
      hasParamRoot(current, paramNames)
    ) {
      const prop = memberExpressionPropertyName(current);
      if (targetProps.has(prop)) checked.add(prop);
      return;
    }
    if (current.type === "Identifier" && !isBindingIdentifier(current)) {
      const prop = propertyAliases.get(current.name);
      if (targetProps.has(prop)) checked.add(prop);
    }
  });
  return checked;
}

export function callUsesPredicateParam(node, paramName) {
  const paramNames = new Set([paramName]);
  return (node.arguments ?? []).some(
    (arg) => arg.type !== "SpreadElement" && hasParamRoot(arg, paramNames),
  );
}

export function hasValidatorDelegation(node, paramName, services, checker) {
  let sawDelegation = false;
  walkNode(node, (current) => {
    if (
      sawDelegation ||
      current.type !== "CallExpression" ||
      !callUsesPredicateParam(current, paramName)
    ) {
      return;
    }
    const callee = current.callee;
    const methodName = callExpressionName(callee);
    const tsCall = services?.esTreeNodeToTSNodeMap.get(current);
    if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      methodName &&
      ZOD_VALIDATOR_METHODS.has(methodName) &&
      isZodMethod(checker, tsCall?.expression?.name)
    ) {
      sawDelegation = true;
    }
  });
  return sawDelegation;
}
