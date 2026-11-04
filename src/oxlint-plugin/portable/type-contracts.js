import {
  checkRedundantPredicate,
  checkTypeAssertion,
  createUndercheckedPredicateVisitors,
  forEachOwnNode,
  topLevelTypeDeclarations,
} from "./type-predicate-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  isObjectSchemaMethod,
  resolveSchemaBuilderCall,
  resolveSchemaMemberChain,
  schemaDiscriminantKeys,
} from "../shared/runtime-schema-libraries.js";
import {
  isFunctionLike,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";
import {
  resolvedPropertyShape,
  resolvedTypeTexts,
} from "../shared/type-services.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

export const noAppeasementCastRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow appeasement type assertions (`as never`, chained assertions `as unknown as T`, collection/error casts, or casting undecoded boundary outputs).",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const checkAssertion = (node) => checkTypeAssertion(node, context);
    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};

function isNullableType(typeNode, aliases, sourceCode, seen = new Set()) {
  if (!typeNode) return false;
  if (
    typeNode.type === "TSNullKeyword" ||
    typeNode.type === "TSUndefinedKeyword"
  ) {
    return true;
  }
  if (typeNode.type === "TSOptionalType") return true;
  if (typeNode.type === "TSUnionType") {
    return typeNode.types.some((type) =>
      isNullableType(type, aliases, sourceCode, seen)
    );
  }
  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    !seen.has(typeNode.typeName.name)
  ) {
    seen.add(typeNode.typeName.name);
    const local = aliases.get(typeNode.typeName.name);
    if (local) return isNullableType(local, aliases, sourceCode, seen);
    return (
      resolvedTypeTexts(typeNode, sourceCode)?.some(
        (text) => text === "null" || text === "undefined"
      ) ?? false
    );
  }
  return false;
}

function checkNullableTuple(node, aliases, context) {
  const elements = node.elementTypes ?? [];
  let nullableCount = 0;
  for (const elem of elements) {
    const inner = elem.type === "TSNamedTupleMember" ? elem.elementType : elem;
    if (elem.type === "TSNamedTupleMember" && elem.optional) {
      nullableCount += 1;
    } else if (isNullableType(inner, aliases, context.sourceCode)) {
      nullableCount += 1;
    }
  }
  if (nullableCount >= 2) {
    context.report({
      node,
      message:
        "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
    });
  }
}

const FAILURE_FIELDS = new Set([
  "error",
  "err",
  "failure",
  "unavailableReason",
  "fault",
]);
const RESULT_TAGS = new Set(["ok", "success", ...schemaDiscriminantKeys]);

function explicitlyNullable(property, sourceCode) {
  if (property.type === "TSPropertySignature") {
    const annotation = property.typeAnnotation?.typeAnnotation;
    if (
      annotation?.type === "TSUnionType" &&
      annotation.types.some((type) => type.type === "TSNullKeyword")
    ) {
      return true;
    }
    return (
      annotation?.type === "TSTypeReference" &&
      (resolvedTypeTexts(annotation, sourceCode)?.includes("null") ?? false)
    );
  }
  const chain = resolveSchemaMemberChain(property.value, sourceCode);
  return chain?.steps.some((step) => step.method === "nullable") ?? false;
}

function checkNullableFailureBag(properties, node, context) {
  const ownerName =
    node.id?.name ??
    (node.parent?.type === "VariableDeclarator" &&
    node.parent.id?.type === "Identifier"
      ? node.parent.id.name
      : "");
  if (
    properties.length < 2 ||
    properties.length > 4 ||
    /(?:Error|Props)(?:Schema)?$/u.test(ownerName)
  ) {
    return;
  }
  const names = properties.map(staticPropertyKey);
  if (names.some((name) => name === null || RESULT_TAGS.has(name))) return;
  const nullableNames = properties
    .filter((property) => explicitlyNullable(property, context.sourceCode))
    .map(staticPropertyKey);
  if (
    nullableNames.length === properties.length &&
    nullableNames.some((name) => FAILURE_FIELDS.has(name)) &&
    nullableNames.some((name) => !FAILURE_FIELDS.has(name))
  ) {
    context.report({
      node,
      message:
        "Untagged nullable failure and payload fields admit contradictory states; use a discriminated success/failure union.",
    });
  }
}

function returnedObjects(fnNode, sourceCode) {
  if (fnNode.body?.type !== "BlockStatement") return null;
  const returnedLiterals = [];
  let complete = true;
  forEachOwnNode(fnNode.body, sourceCode, (node) => {
    if (node.type !== "ReturnStatement") return;
    const argument = unwrapExpression(node.argument);
    if (argument?.type === "ObjectExpression") returnedLiterals.push(argument);
    else complete = false;
  });
  return complete && returnedLiterals.length >= 2 ? returnedLiterals : null;
}

export function constantEntries(objectNode) {
  return new Map(
    objectNode.properties.flatMap((property) => {
      const key = staticPropertyKey(property);
      const literal = property.value;
      return key && literal?.type === "Literal" && !literal.regex
        ? [[key, String(literal.raw)]]
        : [];
    })
  );
}

function checkConstantReturnField(returnedLiterals, context) {
  const entries = returnedLiterals.map(constantEntries);
  if (
    returnedLiterals.some((objectNode) => objectNode.properties.length < 2) ||
    returnedLiterals.every(
      (objectNode, index) =>
        objectNode.properties.length === entries[index].size
    )
  ) {
    return;
  }
  const constant = [...entries[0]].find(
    ([key, raw]) =>
      /^(?:true|false|null)$/u.test(raw) &&
      !RESULT_TAGS.has(key) &&
      entries.every((entry) => entry.get(key) === raw)
  );
  if (constant) {
    context.report({
      node: returnedLiterals[0],
      message: `Every return path hardcodes '${constant[0]}: ${constant[1]}'; compute the real value per branch or remove the dead contract field.`,
    });
  }
}

function outcomeFlag(objectNode) {
  const flag = objectNode.properties.find(
    (property) =>
      (staticPropertyKey(property) === "ok" ||
        staticPropertyKey(property) === "success") &&
      typeof property.value?.value === "boolean"
  );
  return flag ? flag.value.value : null;
}

function nullishKeys(objectNode) {
  return objectNode.properties
    .filter(
      (property) =>
        property.value?.raw === "null" ||
        (property.value?.type === "Identifier" &&
          property.value.name === "undefined")
    )
    .map(staticPropertyKey);
}

function keySignature(objectNode) {
  return objectNode.properties.map(staticPropertyKey).toSorted().join(",");
}

function checkOutcomeFlagErasure(returnedLiterals, context) {
  const success = returnedLiterals.find(
    (objectNode) => outcomeFlag(objectNode) === true
  );
  const failure =
    success &&
    returnedLiterals.find(
      (objectNode) =>
        outcomeFlag(objectNode) === false &&
        keySignature(objectNode) === keySignature(success)
    );
  if (!failure) return;
  const successNulls = nullishKeys(success);
  const failureNulls = nullishKeys(failure);
  if (
    successNulls.some((key) => !failureNulls.includes(key)) &&
    failureNulls.some((key) => !successNulls.includes(key))
  ) {
    context.report({
      node: success,
      message: `Success and failure returns (lines ${success.loc.start.line} and ${failure.loc.start.line}) build the same object with complementary flag and error fields; return a discriminated union so consumers never read a nullable error behind a boolean flag.`,
    });
  }
}

function checkReturnContracts(fnNode, context) {
  const returnedLiterals = returnedObjects(fnNode, context.sourceCode);
  if (!returnedLiterals) return;
  checkConstantReturnField(returnedLiterals, context);
  checkOutcomeFlagErasure(returnedLiterals, context);
}

function checkResultProductType(node, context) {
  const names = new Set(node.members.map(staticPropertyKey));
  if (
    (names.has("ok") || names.has("success")) &&
    (names.has("data") || names.has("value")) &&
    names.has("error") &&
    names.size <= 4
  ) {
    context.report({
      node,
      message:
        "Do not model fallible results as a single `{ ok, data, error }` product type; use a discriminated union (`{ ok: true; data: T } | { ok: false; error: E }`).",
    });
  }
}

function enclosingSingleReturnFunction(objNode) {
  const parent = objNode.parent;
  if (isFunctionLike(parent) && parent.body === objNode) return parent;
  if (
    parent?.type === "ReturnStatement" &&
    parent.parent?.type === "BlockStatement" &&
    parent.parent.body.length === 1 &&
    isFunctionLike(parent.parent.parent)
  ) {
    return parent.parent.parent;
  }
  return null;
}

function projectionSource(node) {
  const roots = node.properties.map((prop) => {
    const member = unwrapExpression(prop.value);
    return prop.type === "Property" &&
      !prop.computed &&
      !prop.shorthand &&
      prop.key?.type === "Identifier" &&
      member?.type === "MemberExpression" &&
      !member.computed &&
      member.object?.type === "Identifier" &&
      member.property?.name === prop.key.name
      ? member.object.name
      : null;
  });
  return roots.every((root) => root && root === roots[0]) ? roots[0] : null;
}

function declaredTypePropertyCount(typeName, sourceCode) {
  const decl = topLevelTypeDeclarations(sourceCode.ast).get(typeName);
  if (decl?.type === "TSInterfaceDeclaration") {
    return decl.body?.body?.length ?? 0;
  }
  if (
    decl?.type === "TSTypeAliasDeclaration" &&
    decl.typeAnnotation?.type === "TSTypeLiteral"
  ) {
    return decl.typeAnnotation.members?.length ?? 0;
  }
  return 0;
}

function isContractProjection(objNode, sourceIdent, sourceCode) {
  const fnNode = enclosingSingleReturnFunction(objNode);
  const parameter = fnNode?.params.length === 1 ? fnNode.params[0] : null;
  const paramType = parameter?.typeAnnotation?.typeAnnotation;
  const returnType = fnNode?.returnType?.typeAnnotation;
  if (
    parameter?.type !== "Identifier" ||
    parameter.name !== sourceIdent ||
    paramType?.type !== "TSTypeReference"
  ) {
    return false;
  }
  if (
    returnType?.type === "TSTypeReference" &&
    sourceCode.getText(paramType.typeName) ===
      sourceCode.getText(returnType.typeName)
  ) {
    return false;
  }
  const resolvedCount =
    resolvedPropertyShape(parameter, sourceCode)?.all.length ?? 0;
  const sourceCount =
    resolvedCount > 0
      ? resolvedCount
      : declaredTypePropertyCount(
          sourceCode.getText(paramType.typeName),
          sourceCode
        );
  return sourceCount === 0 || objNode.properties.length >= sourceCount;
}

function checkContractProjection(node, context) {
  const sourceIdent =
    node.properties.length >= 3 ? projectionSource(node) : null;
  if (
    sourceIdent &&
    isContractProjection(node, sourceIdent, context.sourceCode)
  ) {
    context.report({
      node,
      message: `Object literal restates ${node.properties.length} properties verbatim from '${sourceIdent}'; pass '${sourceIdent}' directly instead of reshaping a parallel bag.`,
    });
  }
}

export const noContractAppeasementProjectionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `{ ok, data, error }` product result envelopes, untagged nullable failure/payload bags, multi-field nullable positional tuples, verbatim 3+ property bag clones, constant return fields, and complementary flag/error return products.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const aliases = new Map();
    const checkFunction = (node) => checkReturnContracts(node, context);
    return {
      Program(node) {
        for (const stmt of node.body) {
          const decl =
            stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
          if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
            aliases.set(decl.id.name, decl.typeAnnotation);
          }
        }
      },
      ObjectExpression(node) {
        checkContractProjection(node, context);
      },
      TSTupleType(node) {
        checkNullableTuple(node, aliases, context);
      },
      TSInterfaceDeclaration(node) {
        if (!node.extends?.length) {
          checkNullableFailureBag(node.body.body, node, context);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type === "TSTypeLiteral") {
          checkNullableFailureBag(node.typeAnnotation.members, node, context);
        }
      },
      TSTypeLiteral(node) {
        checkResultProductType(node, context);
      },
      CallExpression(node) {
        const builder = resolveSchemaBuilderCall(node, context.sourceCode);
        if (
          isObjectSchemaMethod(builder?.method) &&
          builder.args[0]?.type === "ObjectExpression"
        ) {
          checkNullableFailureBag(builder.args[0].properties, node, context);
        }
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noRedundantTypePredicateRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type predicates that restate the parameter type, that TypeScript infers from a nullish callback check, or that conflate a root discriminator with facet narrowing.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const checkFunction = (node) => checkRedundantPredicate(node, context);
    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noUndercheckedTypePredicateRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `x is T` / `asserts x is T` predicates on broad inputs (`unknown`, `any`, `object`, `Record`) that do not read every required field of the target contract.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    return isRuleFile(context)
      ? createUndercheckedPredicateVisitors(context)
      : {};
  },
};
