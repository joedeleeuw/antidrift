import ts from "typescript";

import { callExpressionName } from "./auth-boundary.mjs";
import { isZodMethod } from "./schema-provenance.mjs";

const TS_TYPE_FLAG_ANY = 1;
const TS_TYPE_FLAG_UNKNOWN = 2;
const TS_TYPE_FLAG_OBJECT = ts.TypeFlags.Object;
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
        identifiers
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

export function isAppeasementCastSourceType(type) {
  return Boolean(
    type && type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN)
  );
}

export function isBroadShapeProbeInputType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (isAppeasementCastSourceType(type)) return true;
  return (type.types ?? []).some((part) =>
    isBroadShapeProbeInputType(part, seen)
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
      (param) => param?.type === "Identifier" && param.name === name
    ) ?? null
  );
}

// A typed record is not broad input: only `any`/`unknown`, the empty object
// type, or a dictionary whose values are `any`/`unknown` with no declared fields.
export function isBroadPredicateInputType(checker, type) {
  if (isAppeasementCastSourceType(type)) return true;
  if ((type.flags & TS_TYPE_FLAG_OBJECT) === 0) return false;
  if (checker.getPropertiesOfType(type).length > 0) return false;
  const indexTypes = [
    type.getStringIndexType?.(),
    type.getNumberIndexType?.(),
  ].filter(Boolean);
  return (
    indexTypes.length === 0 || indexTypes.some(isAppeasementCastSourceType)
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

function hasObjectContractProperties(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.types) {
    return type.types.some((part) => hasObjectContractProperties(part, seen));
  }
  return (
    Boolean(type.flags & TS_TYPE_FLAG_OBJECT) &&
    (type.getProperties?.() ?? []).length > 0
  );
}

export function isAppeasementCastTargetType(type) {
  if (isAntidriftBrandedType(type)) return false;
  return hasObjectContractProperties(type);
}

export function isAppeasementContractCast(node, services, checker) {
  if (!isNamedTypeReference(node?.typeAnnotation)) return false;

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
  targetProps
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
    targetProps
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
    const reflected = reflectGetParts(current);
    if (reflected && hasParamRoot(reflected.target, paramNames)) {
      if (targetProps.has(reflected.name)) checked.add(reflected.name);
      return;
    }
    const keyed = keyedHelperCheck(current, (argument) =>
      hasParamRoot(argument, paramNames) &&
      unwrapExpression(argument)?.type === "Identifier"
        ? []
        : null
    );
    if (keyed) {
      if (targetProps.has(keyed[0])) checked.add(keyed[0]);
      return;
    }
    if (current.type === "Identifier" && !isBindingIdentifier(current)) {
      const prop = propertyAliases.get(current.name);
      if (targetProps.has(prop)) checked.add(prop);
    }
  });
  return checked;
}

// A helper called with the predicate value and a literal key, e.g.
// `hasString(value, "id")` or `hasNumber(value.size, "width")`, checks that
// key. Returns the checked path, given the path of the value argument.
function keyedHelperCheck(node, valuePath) {
  if (node?.type !== "CallExpression") return null;
  const key = node.arguments.find(
    (argument) =>
      argument.type === "Literal" && typeof argument.value === "string"
  );
  if (!key) return null;
  for (const argument of node.arguments) {
    if (argument === key || argument.type === "SpreadElement") continue;
    const base = valuePath(argument);
    if (base) return [...base, key.value];
  }
  return null;
}

export function callUsesPredicateParam(node, paramName) {
  const paramNames = new Set([paramName]);
  return (node.arguments ?? []).some(
    (arg) => arg.type !== "SpreadElement" && hasParamRoot(arg, paramNames)
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

function reflectGetParts(node) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (
    callee?.type !== "MemberExpression" ||
    callee.object?.type !== "Identifier" ||
    callee.object.name !== "Reflect" ||
    staticPropertyName(callee.property) !== "get"
  ) {
    return null;
  }
  const name = staticPropertyName(node.arguments?.[1]);
  return name === null ? null : { target: node.arguments[0], name };
}

function staticMemberName(node) {
  if (!node.computed) return staticPropertyName(node.property);
  return node.property?.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : null;
}

// Property path from the predicate parameter: `value.data.tag`,
// `value["_tag"]`, `Reflect.get(value, "kind")`, or a local bound to one.
function paramPropertyPath(expression, paramNames, aliasPaths) {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier") {
    return paramNames.has(node.name) ? [] : (aliasPaths.get(node.name) ?? null);
  }
  if (node?.type === "MemberExpression") {
    const name = staticMemberName(node);
    const base =
      name === null
        ? null
        : paramPropertyPath(node.object, paramNames, aliasPaths);
    return base && [...base, name];
  }
  const reflected = reflectGetParts(node);
  if (!reflected) return null;
  const base = paramPropertyPath(reflected.target, paramNames, aliasPaths);
  return base && [...base, reflected.name];
}

const UNIT_TYPE_FLAGS =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.EnumLiteral;

function isUnitType(type) {
  return (
    (type.flags & UNIT_TYPE_FLAGS) !== 0 &&
    (type.flags & ts.TypeFlags.Union) === 0
  );
}

function isDiscriminantType(type) {
  return type.isUnion() ? type.types.every(isUnitType) : isUnitType(type);
}

function propertyTypeAtPath(checker, type, path) {
  let current = type;
  for (const name of path) {
    const property = checker.getPropertyOfType(
      checker.getNonNullableType(current),
      name
    );
    if (!property) return null;
    current = checker.getTypeOfSymbol(property);
  }
  return checker.getNonNullableType(current);
}

function matchesTargetDiscriminant(checker, targetType, path, valueType) {
  if (path.length === 0 || !isUnitType(valueType)) return false;
  const propertyType = propertyTypeAtPath(checker, targetType, path);
  return Boolean(
    propertyType &&
    isDiscriminantType(propertyType) &&
    checker.isTypeAssignableTo(valueType, propertyType)
  );
}

function instanceofProvesTarget(
  node,
  paramPath,
  services,
  checker,
  targetType
) {
  if (paramPath?.length !== 0) return false;
  const tsConstructor = services.esTreeNodeToTSNodeMap.get(node.right);
  if (!tsConstructor) return false;
  return checker
    .getTypeAtLocation(tsConstructor)
    .getConstructSignatures()
    .some((signature) =>
      checker.isTypeAssignableTo(
        checker.getReturnTypeOfSignature(signature),
        targetType
      )
    );
}

function delegatedPredicateType(
  node,
  paramNames,
  aliasPaths,
  services,
  checker
) {
  const tsCall = services.esTreeNodeToTSNodeMap.get(node);
  const signature = tsCall && checker.getResolvedSignature(tsCall);
  const predicate = signature && checker.getTypePredicateOfSignature(signature);
  if (
    !predicate?.type ||
    predicate.type.flags & (TS_TYPE_FLAG_ANY | TS_TYPE_FLAG_UNKNOWN)
  ) {
    return null;
  }
  const argument = node.arguments?.[predicate.parameterIndex];
  return paramPropertyPath(argument, paramNames, aliasPaths)?.length === 0
    ? { type: predicate.type, argument }
    : null;
}

function isTypeAssertion(node) {
  if (node?.type !== "TSAsExpression" && node?.type !== "TSTypeAssertion") {
    return false;
  }
  const target = node.typeAnnotation;
  return !(
    target?.type === "TSTypeReference" &&
    target.typeName?.type === "Identifier" &&
    target.typeName.name === "const"
  );
}

function containsTypeAssertion(expression, assertedNames) {
  if (!expression) return false;
  let found = false;
  walkNode(expression, (current) => {
    if (
      isTypeAssertion(current) ||
      (current.type === "Identifier" && assertedNames.has(current.name))
    ) {
      found = true;
    }
  });
  return found;
}

function tagRead(side, aliasInits) {
  let node = side;
  while (
    node?.type === "ChainExpression" ||
    node?.type === "TSNonNullExpression"
  ) {
    node = node.expression;
  }
  if (node?.type === "Identifier" && aliasInits.has(node.name)) {
    return tagRead(aliasInits.get(node.name), aliasInits);
  }
  if (node?.type === "MemberExpression") {
    const name = staticMemberName(node);
    return name === null ? null : { base: node.object, name };
  }
  const reflected = reflectGetParts(node);
  return reflected && { base: reflected.target, name: reflected.name };
}

// A literal tag identifies a variant, and so its payload, only when the value
// it is read from is already a closed union to TypeScript. Read from raw
// any/unknown/open-record input, or through a type assertion, the tag proves
// the tag and nothing else.
function isClosedTagSource(base, name, assertedNames, services, checker) {
  if (containsTypeAssertion(base, assertedNames)) return false;
  const tsBase = services.esTreeNodeToTSNodeMap.get(base);
  if (!tsBase) return false;
  const baseType = checker.getTypeAtLocation(tsBase);
  if (isBroadPredicateInputType(checker, baseType)) return false;
  const tagType = propertyTypeAtPath(checker, baseType, [name]);
  return Boolean(tagType && isDiscriminantType(tagType));
}

// Nominal and discriminant evidence a field count cannot see: an `instanceof`
// whose instance type satisfies the asserted type, a delegated type predicate,
// or a literal equality on a discriminant property of the asserted type read
// from a value that is already a closed union.
export function predicateContractEvidence(
  node,
  paramName,
  targetType,
  services,
  checker
) {
  const paramNames = predicateValueNames(node, paramName);
  // Locals bound to the predicate value through a type assertion, e.g.
  // `const candidate = data as { source?: unknown }`.
  const assertedNames = new Set();
  const aliasPaths = new Map();
  const aliasInits = new Map();
  const checked = new Set();
  let proven = false;
  walkNode(node, (current) => {
    if (proven) return;
    if (
      current.type === "VariableDeclarator" &&
      current.id?.type === "Identifier"
    ) {
      if (
        paramNames.has(current.id.name) &&
        containsTypeAssertion(current.init, assertedNames)
      ) {
        assertedNames.add(current.id.name);
      }
      const path = paramPropertyPath(current.init, paramNames, aliasPaths);
      if (path?.length) {
        aliasPaths.set(current.id.name, path);
        aliasInits.set(current.id.name, current.init);
      }
      return;
    }
    if (current.type === "BinaryExpression") {
      if (current.operator === "instanceof") {
        proven = instanceofProvesTarget(
          current,
          paramPropertyPath(current.left, paramNames, aliasPaths),
          services,
          checker,
          targetType
        );
        return;
      }
      if (current.operator !== "===" && current.operator !== "==") return;
      proven = [
        [current.left, current.right],
        [current.right, current.left],
      ].some(([side, other]) => {
        const path = paramPropertyPath(side, paramNames, aliasPaths);
        const tsOther = services.esTreeNodeToTSNodeMap.get(other);
        const tag = path && tagRead(side, aliasInits);
        return Boolean(
          tag &&
          tsOther &&
          matchesTargetDiscriminant(
            checker,
            targetType,
            path,
            checker.getTypeAtLocation(tsOther)
          ) &&
          isClosedTagSource(
            tag.base,
            tag.name,
            assertedNames,
            services,
            checker
          )
        );
      });
      return;
    }
    if (current.type !== "CallExpression") return;
    const delegated = delegatedPredicateType(
      current,
      paramNames,
      aliasPaths,
      services,
      checker
    );
    if (!delegated) return;
    if (checker.isTypeAssignableTo(delegated.type, targetType)) {
      proven = true;
      return;
    }
    for (const property of checker.getPropertiesOfType(delegated.type)) {
      checked.add(property.name);
      const propertyType = checker.getNonNullableType(
        checker.getTypeOfSymbol(property)
      );
      if (
        matchesTargetDiscriminant(
          checker,
          targetType,
          [property.name],
          propertyType
        ) &&
        isClosedTagSource(
          delegated.argument,
          property.name,
          assertedNames,
          services,
          checker
        )
      ) {
        proven = true;
      }
    }
  });
  return { proven, checked };
}

// Dotted property paths the body reads or `in`-checks on the predicate value,
// e.g. `function.name` for `typeof value.function?.name === "string"`.
export function checkedPropertyPaths(node, paramName) {
  const paramNames = predicateValueNames(node, paramName);
  const aliasPaths = new Map();
  const paths = new Set();
  walkNode(node, (current) => {
    let path = null;
    if (
      current.type === "VariableDeclarator" &&
      current.id?.type === "Identifier"
    ) {
      const aliased = paramPropertyPath(current.init, paramNames, aliasPaths);
      if (aliased?.length) aliasPaths.set(current.id.name, aliased);
    } else if (
      current.type === "BinaryExpression" &&
      current.operator === "in"
    ) {
      const base = paramPropertyPath(current.right, paramNames, aliasPaths);
      const name = staticPropertyName(current.left);
      path = base && name !== null ? [...base, name] : null;
    } else if (current.type === "MemberExpression") {
      path = paramPropertyPath(current, paramNames, aliasPaths);
    } else if (current.type === "CallExpression") {
      path =
        paramPropertyPath(current, paramNames, aliasPaths) ??
        keyedHelperCheck(current, (argument) =>
          paramPropertyPath(argument, paramNames, aliasPaths)
        );
    }
    if (path?.length) paths.add(path.join("."));
  });
  return paths;
}

function literalOfUnitType(type) {
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return type.intrinsicName === "true";
  }
  return undefined;
}

// The variants of a union target the body can accept. The body's literal
// comparisons on each top-level field (`===`/`!==` or `switch` cases) are
// collected; a variant whose literal tag the body never compares against,
// while it does compare that field to other literals, is excluded, e.g.
// `type === "addRules"` excludes the `setMode` variant.
export function claimedTargetVariants(
  node,
  paramName,
  variants,
  services,
  checker
) {
  const paramNames = predicateValueNames(node, paramName);
  const aliasPaths = new Map();
  const comparedLiterals = new Map();
  const recordComparison = (side, other) => {
    const path = paramPropertyPath(side, paramNames, aliasPaths);
    const tsOther = services.esTreeNodeToTSNodeMap.get(other);
    if (path?.length !== 1 || !tsOther) return;
    const literal = literalOfUnitType(checker.getTypeAtLocation(tsOther));
    if (literal === undefined) return;
    const fieldLiterals = comparedLiterals.get(path[0]) ?? new Set();
    fieldLiterals.add(literal);
    comparedLiterals.set(path[0], fieldLiterals);
  };
  walkNode(node, (current) => {
    if (
      current.type === "VariableDeclarator" &&
      current.id?.type === "Identifier"
    ) {
      const path = paramPropertyPath(current.init, paramNames, aliasPaths);
      if (path?.length) aliasPaths.set(current.id.name, path);
    } else if (
      current.type === "BinaryExpression" &&
      ["===", "==", "!==", "!="].includes(current.operator)
    ) {
      recordComparison(current.left, current.right);
      recordComparison(current.right, current.left);
    } else if (current.type === "SwitchStatement") {
      for (const switchCase of current.cases) {
        if (switchCase.test) {
          recordComparison(current.discriminant, switchCase.test);
        }
      }
    }
  });
  return variants.filter((variant) =>
    [...comparedLiterals].every(([field, fieldLiterals]) => {
      const property = checker.getPropertyOfType(variant, field);
      const tag =
        property && literalOfUnitType(checker.getTypeOfSymbol(property));
      return tag === undefined || fieldLiterals.has(tag);
    })
  );
}
