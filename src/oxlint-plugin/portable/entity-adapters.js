import { ruleFilename } from "../shared/rule-scope.js";
import {
  sameSourcePath,
  sourcePath,
  sourcePathName,
} from "../shared/source-path.js";
import {
  constInitializer,
  findVariable,
  isFunctionLike,
  isTestFile,
  nearestFunction,
  staticPropertyKey,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";
import {
  firstPartyContract,
  getResolvedType,
  getTypeServices,
  isEntityIdentityKey,
  isOptionalProperty,
} from "../shared/type-services.js";

function stableAssignment(expression, sourceCode) {
  const node = unwrapExpression(expression);
  if (node?.type === "Literal" && !node.regex) {
    return { literal: `${typeof node.value}:${String(node.value)}` };
  }
  if (node?.type !== "Identifier") return null;
  const binding = findVariable(sourceCode, node);
  return binding ? { binding } : null;
}

function sameAssignment(left, right) {
  if (!left || !right) return false;
  return left.binding
    ? left.binding === right.binding
    : left.literal === right.literal;
}

const IDENTIFIER_PROPERTY = /^[a-z][A-Za-z0-9_]*$/u;

function aliasWrite(propertyName, expression, sourceCode) {
  if (
    !propertyName ||
    propertyName === "id" ||
    propertyName === "key" ||
    !IDENTIFIER_PROPERTY.test(propertyName)
  ) {
    return null;
  }
  const assigned = stableAssignment(expression, sourceCode);
  return assigned
    ? {
        propertyName,
        normalized: propertyName.toLowerCase().replaceAll("_", ""),
        assigned,
      }
    : null;
}

function reportAliasWrite(write, previous, node, context) {
  const matching = previous.find(
    (candidate) =>
      candidate.normalized === write.normalized &&
      candidate.propertyName !== write.propertyName &&
      sameAssignment(candidate.assigned, write.assigned)
  );
  if (!matching) return;
  context.report({
    node,
    message: `Assigns the same value to spelling-alias properties '${matching.propertyName}' and '${write.propertyName}'; keep one canonical property name on the contract.`,
  });
}

export function checkObjectAliasWrites(node, context) {
  const previous = [];
  for (const property of node.properties) {
    const write = aliasWrite(
      staticPropertyKey(property),
      property.value,
      context.sourceCode
    );
    if (!write) {
      continue;
    }
    reportAliasWrite(write, previous, property, context);
    previous.push(write);
  }
}

export function checkBlockAliasWrites(block, context) {
  const previous = [];
  for (const statement of block.body) {
    const assignment =
      statement.type === "ExpressionStatement" ? statement.expression : null;
    const member =
      assignment?.type === "AssignmentExpression" &&
      assignment.operator === "=" &&
      assignment.left.type === "MemberExpression"
        ? assignment.left
        : null;
    const target = member && sourcePath(member.object, context.sourceCode);
    const write =
      target &&
      aliasWrite(
        staticPropertyName(member),
        assignment.right,
        context.sourceCode
      );
    if (!write) {
      previous.length = 0;
      continue;
    }
    reportAliasWrite(
      write,
      previous.filter((candidate) => sameSourcePath(target, candidate.target)),
      assignment,
      context
    );
    previous.push({ ...write, target });
  }
}

function emptyConstant(expression, sourceCode, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (!node) return false;
  if (node.type === "Literal") {
    return (
      node.value === null ||
      node.value === false ||
      node.value === 0 ||
      node.value === ""
    );
  }
  if (node.type === "ArrayExpression") return node.elements.length === 0;
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" &&
        emptyConstant(property.value, sourceCode, new Set(seen))
    );
  }
  if (node.type !== "Identifier") return false;
  const binding = findVariable(sourceCode, node);
  if (node.name === "undefined" && !binding?.defs.length) return true;
  if (
    !binding ||
    seen.has(binding) ||
    binding.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  ) {
    return false;
  }
  seen.add(binding);
  return emptyConstant(constInitializer(sourceCode, node), sourceCode, seen);
}

function copiedEntitySource(node, sourceCode) {
  const copied = node.properties.flatMap((property) => {
    const member = unwrapExpression(property.value);
    const key = staticPropertyKey(property);
    const field = staticPropertyName(member);
    const origin =
      member?.type === "MemberExpression" &&
      sourcePath(member.object, sourceCode);
    return key && field && origin
      ? [{ key, field, origin, source: member.object }]
      : [];
  });
  return copied.find(
    (property) =>
      isEntityIdentityKey(property.key) &&
      isEntityIdentityKey(property.field) &&
      property.key !== "number" &&
      property.field !== "number" &&
      copied.some(
        (peer) =>
          peer !== property && sameSourcePath(peer.origin, property.origin)
      )
  );
}

function explicitTarget(node, sourceCode, services) {
  const contextual = services.checker.getContextualType(
    services.nodeMap.get(node)
  );
  if (contextual) return contextual;
  const parent = node.parent;
  if (
    parent?.type !== "ReturnStatement" &&
    !(isFunctionLike(parent) && parent.body === node)
  ) {
    return null;
  }
  const annotation = nearestFunction(node)?.returnType?.typeAnnotation;
  return annotation ? getResolvedType(annotation, sourceCode) : null;
}

function adapterTarget(node, copied, sourceCode) {
  if (
    node.parent?.type === "TSAsExpression" ||
    node.parent?.type === "TSTypeAssertion"
  ) {
    return { asserted: true };
  }
  const services = getTypeServices(sourceCode);
  if (!services) return null;
  const target = firstPartyContract(
    explicitTarget(node, sourceCode, services),
    services
  );
  const source = firstPartyContract(
    getResolvedType(copied.source, sourceCode),
    services
  );
  if (
    !target ||
    !source ||
    target.symbol === source.symbol ||
    source.properties.length < 4
  ) {
    return null;
  }
  if (
    /^(?:Create|New|Insert|Init|Build|Draft)|(?:Command|Input|Params|Args|Request|Payload|Options|Init)$/u.test(
      source.name
    )
  ) {
    return null;
  }
  return {
    required: new Set(
      target.properties
        .filter((property) => !isOptionalProperty(property))
        .map((property) => property.name)
    ),
  };
}

export function checkPaddedEntity(node, context, resultTags) {
  if (isTestFile(ruleFilename(context))) return;
  const copied = copiedEntitySource(node, context.sourceCode);
  if (!copied) return;
  const target = adapterTarget(node, copied, context.sourceCode);
  if (!target) return;
  const fillers = new Set(
    node.properties
      .filter((property) => {
        const key = staticPropertyKey(property);
        return (
          key &&
          !resultTags.has(key) &&
          (target.asserted || target.required.has(key)) &&
          emptyConstant(property.value, context.sourceCode)
        );
      })
      .map(staticPropertyKey)
  );
  if (fillers.size < 3) return;
  context.report({
    node,
    message: `Object literal adapts '${sourcePathName(copied.origin)}' by copying its identity and padding ${fillers.size} required fields with empty/placeholder constants; project a narrower view contract or union instead of fabricating missing entity state.`,
  });
}
