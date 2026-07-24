import {
  getFunctionNode,
  isBoundary,
  unwrapExpression,
} from "../../semantic-adapters/local-ast-rules.mjs";
import ts from "typescript";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const collectionMetadataMemberNames = new Set(["length", "size"]);
function hasExplicitReturnType(fn) {
  return Boolean(fn?.returnType);
}
function assignmentTarget(node) {
  return node?.type === "AssignmentPattern" ? node.left : node;
}
function nestedObjectPattern(node) {
  const target = assignmentTarget(node);
  return target?.type === "ObjectPattern" ? target : null;
}
function memberExpressionRootName(expression) {
  let cur = unwrapExpression(expression);
  while (cur?.type === "MemberExpression") {
    cur = unwrapExpression(cur.object);
  }
  return cur?.type === "Identifier" ? cur.name : null;
}
function terminalMemberName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped?.type !== "MemberExpression" ||
    unwrapped.computed ||
    unwrapped.property?.type !== "Identifier"
  ) {
    return null;
  }
  return unwrapped.property.name;
}
function typeNameText(typeName) {
  if (typeName?.type === "Identifier") {
    return typeName.name;
  }
  if (typeName?.type === "TSQualifiedName") {
    return typeNameText(typeName.left) ?? typeName.right?.name ?? null;
  }
  return null;
}
function collectTypeOwnerNames(typeNode, names = new Set()) {
  if (!typeNode) {
    return names;
  }
  if (typeNode.type === "TSTypeReference") {
    const name = typeNameText(typeNode.typeName);
    if (name) {
      names.add(name);
    }
    return names;
  }
  if (typeNode.type === "TSIndexedAccessType") {
    collectTypeOwnerNames(typeNode.objectType, names);
    return names;
  }
  if (
    typeNode.type === "TSUnionType" ||
    typeNode.type === "TSIntersectionType"
  ) {
    for (const part of typeNode.types ?? []) {
      collectTypeOwnerNames(part, names);
    }
    return names;
  }
  if (typeNode.type === "TSArrayType") {
    collectTypeOwnerNames(typeNode.elementType, names);
    return names;
  }
  if (typeNode.type === "TSTypeOperator") {
    collectTypeOwnerNames(typeNode.typeAnnotation, names);
    return names;
  }
  if (typeNode.type === "TSParenthesizedType") {
    collectTypeOwnerNames(typeNode.typeAnnotation, names);
  }
  return names;
}
function parameterTypeNode(param) {
  const target = assignmentTarget(param);
  return (
    target?.typeAnnotation?.typeAnnotation ??
    param?.typeAnnotation?.typeAnnotation ??
    null
  );
}
function tsTypeForNode(node, services, checker) {
  const tsNode = node && services.esTreeNodeToTSNodeMap.get(node);
  return tsNode ? checker.getTypeAtLocation(tsNode) : null;
}
function tsTypeFromTypeNode(typeNode, services, checker) {
  const tsNode = typeNode && services.esTreeNodeToTSNodeMap.get(typeNode);
  return tsNode && ts.isTypeNode(tsNode)
    ? checker.getTypeFromTypeNode(tsNode)
    : null;
}
function literalKey(value) {
  return `${typeof value}:${String(value)}`;
}
function expressionLiteralKey(expression) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type === "Literal") {
    return literalKey(unwrapped.value);
  }
  if (
    unwrapped?.type === "TemplateLiteral" &&
    unwrapped.expressions.length === 0
  ) {
    return literalKey(unwrapped.quasis[0]?.value?.cooked ?? "");
  }
  return null;
}
function typeLiteralKeys(type, out = new Set()) {
  if (!type) {
    return out;
  }
  if (type.isUnion?.()) {
    for (const part of type.types) {
      typeLiteralKeys(part, out);
    }
    return out;
  }
  if (type.isStringLiteral?.()) {
    out.add(literalKey(type.value));
    return out;
  }
  if (type.isNumberLiteral?.()) {
    out.add(literalKey(type.value));
    return out;
  }
  const intrinsic = type.intrinsicName;
  if (intrinsic === "true") {
    out.add(literalKey(true));
  }
  if (intrinsic === "false") {
    out.add(literalKey(false));
  }
  return out;
}
function collectObjectPatternBindings(
  pattern,
  bindings,
  ownerNames,
  services,
  checker,
) {
  for (const property of pattern.properties ?? []) {
    if (property.type === "RestElement") {
      const target = assignmentTarget(property.argument);
      if (target?.type === "Identifier") {
        bindings.set(target.name, {
          kind: "destructured",
          type: tsTypeForNode(target, services, checker),
          ownerNames,
        });
      }
      continue;
    }
    const value = assignmentTarget(property.value);
    if (value?.type === "Identifier") {
      bindings.set(value.name, {
        kind: "destructured",
        type: tsTypeForNode(value, services, checker),
        ownerNames,
      });
      continue;
    }
    const nested = nestedObjectPattern(property.value);
    if (nested) {
      collectObjectPatternBindings(
        nested,
        bindings,
        ownerNames,
        services,
        checker,
      );
    }
  }
}
function sourceBindingsForFunction(fn, services, checker) {
  const bindings = new Map();
  for (const param of fn.params ?? []) {
    const target = assignmentTarget(param);
    const ownerNames = collectTypeOwnerNames(parameterTypeNode(param));
    if (target?.type === "Identifier") {
      bindings.set(target.name, {
        kind: "identity",
        type: tsTypeForNode(target, services, checker),
        ownerNames,
      });
      continue;
    }
    const pattern = nestedObjectPattern(param);
    if (pattern) {
      collectObjectPatternBindings(
        pattern,
        bindings,
        ownerNames,
        services,
        checker,
      );
    }
  }
  return bindings;
}
function returnTypeForFunction(fn, services, checker) {
  return tsTypeFromTypeNode(fn.returnType?.typeAnnotation, services, checker);
}
function returnOwnerNames(fn) {
  return collectTypeOwnerNames(fn.returnType?.typeAnnotation);
}
function ownerNamesForBindings(bindings) {
  const names = new Set();
  for (const binding of bindings.values()) {
    for (const name of binding.ownerNames ?? []) {
      names.add(name);
    }
  }
  return names;
}
function disjointNonemptySets(left, right) {
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  for (const item of left) {
    if (right.has(item)) {
      return false;
    }
  }
  return true;
}
function isUndefinedFallback(expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    !unwrapped ||
    (unwrapped.type === "Identifier" && unwrapped.name === "undefined") ||
    (unwrapped.type === "UnaryExpression" && unwrapped.operator === "void")
  );
}
function projectionSourceForExpression(
  expression,
  bindings,
  services,
  checker,
) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type === "Identifier") {
    const binding = bindings.get(unwrapped.name);
    if (!binding) {
      return null;
    }
    return {
      kind: binding.kind,
      type: tsTypeForNode(unwrapped, services, checker),
    };
  }
  if (unwrapped?.type !== "MemberExpression") {
    return null;
  }
  const terminalName = terminalMemberName(unwrapped);
  if (terminalName && collectionMetadataMemberNames.has(terminalName)) {
    return null;
  }
  const rootName = memberExpressionRootName(unwrapped);
  if (!rootName || !bindings.has(rootName)) {
    return null;
  }
  return {
    kind: "member",
    type: tsTypeForNode(unwrapped, services, checker),
  };
}
function sourceConstraintFromExpression(
  expression,
  bindings,
  sourceCode,
  services,
  checker,
) {
  const source = projectionSourceForExpression(
    expression,
    bindings,
    services,
    checker,
  );
  if (!source) {
    return null;
  }
  const typeKeys = typeLiteralKeys(source.type);
  return {
    key: sourceCode.getText(unwrapExpression(expression)),
    typeKeys,
  };
}
function equalityConstraints(test, bindings, sourceCode, services, checker) {
  const unwrapped = unwrapExpression(test);
  if (unwrapped?.type === "LogicalExpression" && unwrapped.operator === "||") {
    return [
      ...equalityConstraints(
        unwrapped.left,
        bindings,
        sourceCode,
        services,
        checker,
      ),
      ...equalityConstraints(
        unwrapped.right,
        bindings,
        sourceCode,
        services,
        checker,
      ),
    ];
  }
  if (
    unwrapped?.type !== "BinaryExpression" ||
    (unwrapped.operator !== "===" && unwrapped.operator !== "==")
  ) {
    return [];
  }
  const leftLiteral = expressionLiteralKey(unwrapped.left);
  const rightLiteral = expressionLiteralKey(unwrapped.right);
  const sourceExpression = leftLiteral ? unwrapped.right : unwrapped.left;
  const literal = leftLiteral ?? rightLiteral;
  if (!literal) {
    return [];
  }
  const constraint = sourceConstraintFromExpression(
    sourceExpression,
    bindings,
    sourceCode,
    services,
    checker,
  );
  if (!constraint || !constraint.typeKeys.has(literal)) {
    return [];
  }
  return [{ key: constraint.key, literal }];
}
function addConstraint(constraints, constraint) {
  if (!constraint) {
    return constraints;
  }
  const next = new Map(constraints);
  const values = new Set(next.get(constraint.key));
  values.add(constraint.literal);
  next.set(constraint.key, values);
  return next;
}
function matchingLiteralProjection(literal, constraints) {
  for (const values of constraints.values()) {
    if (values.size === 1 && values.has(literal)) {
      return true;
    }
  }
  return false;
}
function sameType(checker, left, right) {
  return Boolean(
    left &&
    right &&
    checker.isTypeAssignableTo(left, right) &&
    checker.isTypeAssignableTo(right, left),
  );
}
function sameTypeIgnoringNullish(checker, left, right) {
  return sameType(
    checker,
    left && checker.getNonNullableType(left),
    right && checker.getNonNullableType(right),
  );
}
function collectExpressionWithTestConstraints(
  expression,
  test,
  constraints,
  context,
) {
  const { records, bindings, sourceCode, services, checker } = context;
  const nextConstraints = equalityConstraints(
    test,
    bindings,
    sourceCode,
    services,
    checker,
  );
  const branches =
    nextConstraints.length === 0
      ? [constraints]
      : nextConstraints.map((constraint) =>
          addConstraint(constraints, constraint),
        );
  for (const branchConstraints of branches) {
    collectReturnRecordsFromExpression(
      expression,
      branchConstraints,
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
  }
}
function collectReturnRecordsFromExpression(
  expression,
  constraints,
  records,
  bindings,
  sourceCode,
  services,
  checker,
) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type === "ConditionalExpression") {
    collectExpressionWithTestConstraints(
      unwrapped.consequent,
      unwrapped.test,
      constraints,
      { records, bindings, sourceCode, services, checker },
    );
    collectReturnRecordsFromExpression(
      unwrapped.alternate,
      constraints,
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
    return;
  }
  if (isUndefinedFallback(unwrapped)) {
    records.push({ kind: "fallback" });
    return;
  }
  const source = projectionSourceForExpression(
    unwrapped,
    bindings,
    services,
    checker,
  );
  if (source) {
    records.push(source);
    return;
  }
  const literal = expressionLiteralKey(unwrapped);
  if (literal && matchingLiteralProjection(literal, constraints)) {
    records.push({
      kind: "literal",
      type: tsTypeForNode(unwrapped, services, checker),
    });
    return;
  }
  records.push({ kind: "unsupported" });
}
function collectReturnRecordsFromStatements(
  statements,
  constraints,
  records,
  bindings,
  sourceCode,
  services,
  checker,
) {
  for (const child of statements ?? []) {
    collectReturnRecordsFromStatement(
      child,
      constraints,
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
  }
}
function collectStatementWithTestConstraints(
  statement,
  test,
  constraints,
  context,
) {
  const { records, bindings, sourceCode, services, checker } = context;
  const nextConstraints = equalityConstraints(
    test,
    bindings,
    sourceCode,
    services,
    checker,
  );
  const branches =
    nextConstraints.length === 0
      ? [constraints]
      : nextConstraints.map((constraint) =>
          addConstraint(constraints, constraint),
        );
  for (const branchConstraints of branches) {
    collectReturnRecordsFromStatement(
      statement,
      branchConstraints,
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
  }
}
function collectSwitchReturnRecords(
  statement,
  constraints,
  records,
  bindings,
  sourceCode,
  services,
  checker,
) {
  const discriminant = sourceConstraintFromExpression(
    statement.discriminant,
    bindings,
    sourceCode,
    services,
    checker,
  );
  for (const switchCase of statement.cases ?? []) {
    const literal = expressionLiteralKey(switchCase.test);
    const nextConstraints =
      discriminant && literal && discriminant.typeKeys.has(literal)
        ? addConstraint(constraints, { key: discriminant.key, literal })
        : constraints;
    collectReturnRecordsFromStatements(
      switchCase.consequent,
      nextConstraints,
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
  }
}
function collectReturnRecordsFromStatement(
  statement,
  constraints,
  records,
  bindings,
  sourceCode,
  services,
  checker,
) {
  switch (statement.type) {
    case "ReturnStatement":
      collectReturnRecordsFromExpression(
        statement.argument,
        constraints,
        records,
        bindings,
        sourceCode,
        services,
        checker,
      );
      return;
    case "BlockStatement":
      collectReturnRecordsFromStatements(
        statement.body,
        constraints,
        records,
        bindings,
        sourceCode,
        services,
        checker,
      );
      return;
    case "IfStatement":
      collectStatementWithTestConstraints(
        statement.consequent,
        statement.test,
        constraints,
        { records, bindings, sourceCode, services, checker },
      );
      if (statement.alternate) {
        collectReturnRecordsFromStatement(
          statement.alternate,
          constraints,
          records,
          bindings,
          sourceCode,
          services,
          checker,
        );
      }
      return;
    case "SwitchStatement":
      collectSwitchReturnRecords(
        statement,
        constraints,
        records,
        bindings,
        sourceCode,
        services,
        checker,
      );
      return;
    default:
      records.push({ kind: "unsupported" });
  }
}
function containsCallOrNew(node) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => containsCallOrNew(child))) {
        return true;
      }
      continue;
    }
    if (containsCallOrNew(value)) {
      return true;
    }
  }
  return false;
}
function returnProjectionRecords(fn, bindings, sourceCode, services, checker) {
  const records = [];
  if (fn.body?.type === "BlockStatement") {
    for (const statement of fn.body.body) {
      collectReturnRecordsFromStatement(
        statement,
        new Map(),
        records,
        bindings,
        sourceCode,
        services,
        checker,
      );
    }
  } else {
    collectReturnRecordsFromExpression(
      fn.body,
      new Map(),
      records,
      bindings,
      sourceCode,
      services,
      checker,
    );
  }
  return records;
}
function contractProjectionProof(fn, sourceCode, services, checker) {
  if (containsCallOrNew(fn.body)) {
    return false;
  }
  const returnType = returnTypeForFunction(fn, services, checker);
  if (!returnType) {
    return false;
  }
  const bindings = sourceBindingsForFunction(fn, services, checker);
  if (bindings.size === 0) {
    return false;
  }
  const records = returnProjectionRecords(
    fn,
    bindings,
    sourceCode,
    services,
    checker,
  );
  const meaningful = records.filter((record) => record.kind !== "fallback");
  if (meaningful.length === 0) {
    return false;
  }
  if (
    meaningful.some((record) => record.kind === "unsupported" || !record.type)
  ) {
    return false;
  }
  const sourceOwners = ownerNamesForBindings(bindings);
  const targetOwners = returnOwnerNames(fn);
  if (disjointNonemptySets(sourceOwners, targetOwners)) {
    return true;
  }
  return meaningful.every(
    (record) =>
      record.kind !== "identity" &&
      sameTypeIgnoringNullish(checker, record.type, returnType),
  );
}
// Visit free functions, arrow consts, and class methods/fields uniformly — agents hide the same
// contract-appeasement patterns in any of these forms.
const callableVisitors = (check) => ({
  FunctionDeclaration: check,
  VariableDeclarator: check,
  MethodDefinition: check,
  PropertyDefinition: check,
  Property: check,
});
function checkContractAppeasementProjection(node, context, services, checker) {
  if (isBoundary(node)) {
    return;
  }
  const fn = getFunctionNode(node);
  if (!fn || !hasExplicitReturnType(fn)) {
    return;
  }
  if (contractProjectionProof(fn, context.sourceCode, services, checker)) {
    context.report({
      node,
      message:
        "Do not project one owned value contract into another return contract just to satisfy a type. Use the source value directly, or construct/validate the target contract at its owning boundary.",
    });
  }
}
export function ruleNoContractAppeasementProjection() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow internal helpers that project source values into explicit return contracts without construction or validation.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-contract-appeasement-projection",
        );
      }
      const checker = services.program.getTypeChecker();
      return callableVisitors((node) =>
        checkContractAppeasementProjection(node, context, services, checker),
      );
    },
  };
}
