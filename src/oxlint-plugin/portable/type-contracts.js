import { checkRedundantUnknownHelper } from "./boundary-decode-checks.js";
import {
  checkRedundantPredicate,
  checkTypeAssertion,
  createUndercheckedPredicateVisitors,
  forEachOwnNode,
  topLevelTypeDeclarations,
} from "./type-predicate-checks.js";
import { checkErasedUnknownReparse } from "./schema-reparse-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  isObjectSchemaMethod,
  resolveSchemaBuilderCall,
  resolveSchemaMemberChain,
  schemaDiscriminantKeys,
} from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";
import {
  closedStringLiteralUnionValues,
  hasTypeChecker,
} from "../shared/type-services.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

export const noAppeasementCastRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow appeasement type assertions (`as any`, `as unknown as T`, or casting object literals with `as T`).",
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

function isClosedKeyType(keyType, sourceCode, depth = 0) {
  if (
    keyType?.type === "TSLiteralType" ||
    (keyType?.type === "TSTypeOperator" && keyType.operator === "keyof") ||
    (keyType?.type === "TSUnionType" &&
      keyType.types.every((member) => member.type === "TSLiteralType"))
  ) {
    return true;
  }
  if (keyType?.type !== "TSTypeReference" || depth > 4) return false;
  const alias = topLevelTypeDeclarations(sourceCode.ast).get(
    keyType.typeName?.name
  )?.typeAnnotation;
  if (alias) return isClosedKeyType(alias, sourceCode, depth + 1);
  return (
    hasTypeChecker(sourceCode) &&
    (closedStringLiteralUnionValues(keyType, sourceCode)?.length ?? 0) > 0
  );
}

function isMemberWritten(identifier, sourceCode) {
  return (findVariable(sourceCode, identifier)?.references ?? []).some(
    (ref) => {
      const member = ref.identifier.parent;
      const write = member?.parent;
      return (
        member?.type === "MemberExpression" &&
        member.object === ref.identifier &&
        ((write?.type === "AssignmentExpression" && write.left === member) ||
          write?.type === "UpdateExpression" ||
          (write?.type === "UnaryExpression" && write.operator === "delete"))
      );
    }
  );
}

function checkCaseTableAnnotation(node, context) {
  const sourceCode = context.sourceCode;
  const annotation = node.id?.typeAnnotation?.typeAnnotation;
  const init = unwrapExpression(node.init);
  if (
    node.parent?.kind !== "const" ||
    node.id.type !== "Identifier" ||
    annotation?.type !== "TSTypeReference" ||
    annotation.typeName?.name !== "Record" ||
    init?.type !== "ObjectExpression" ||
    init.properties.length === 0 ||
    !isClosedKeyType(annotation.typeArguments?.params?.[0], sourceCode) ||
    isMemberWritten(node.id, sourceCode)
  ) {
    return;
  }
  const typeText = sourceCode.getText(annotation);
  context.report({
    node: node.id,
    message: `Case table '${node.id.name}' is annotated \`${typeText}\`, which erases each entry's own type; write \`{ ... } satisfies ${typeText}\` instead.`,
  });
}

export const noAppeasementErasureRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow widening known values to `unknown` only to re-assert or re-parse a narrower contract, `Record<ClosedKey, V>` case-table annotations, and unknown-error helpers applied to known errors.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      CallExpression(node) {
        checkRedundantUnknownHelper(node, context);
      },
      VariableDeclarator(node) {
        checkCaseTableAnnotation(node, context);
        checkErasedUnknownReparse(node, context);
      },
    };
  },
};

function isNullableType(typeNode, aliases, seen = new Set()) {
  if (!typeNode) return false;
  if (
    typeNode.type === "TSNullKeyword" ||
    typeNode.type === "TSUndefinedKeyword"
  ) {
    return true;
  }
  if (typeNode.type === "TSOptionalType") return true;
  if (typeNode.type === "TSUnionType") {
    return typeNode.types.some((type) => isNullableType(type, aliases, seen));
  }
  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    !seen.has(typeNode.typeName.name)
  ) {
    seen.add(typeNode.typeName.name);
    return isNullableType(aliases.get(typeNode.typeName.name), aliases, seen);
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
    } else if (isNullableType(inner, aliases)) {
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
    return (
      annotation?.type === "TSUnionType" &&
      annotation.types.some((type) => type.type === "TSNullKeyword")
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
  return objectNode.properties.map(staticPropertyKey).sort().join(",");
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

export function checkReturnContracts(fnNode, context) {
  const returnedLiterals = returnedObjects(fnNode, context.sourceCode);
  if (!returnedLiterals) return;
  checkConstantReturnField(returnedLiterals, context);
  checkOutcomeFlagErasure(returnedLiterals, context);
}

export function checkResultProductType(node, context) {
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

export const noNullablePositionalTupleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow tuple types with 2 or more nullable positional elements and untagged nullable failure/payload product bags.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const aliases = new Map();

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
      CallExpression(node) {
        const builder = resolveSchemaBuilderCall(node, context.sourceCode);
        if (
          isObjectSchemaMethod(builder?.method) &&
          builder.args[0]?.type === "ObjectExpression"
        ) {
          checkNullableFailureBag(builder.args[0].properties, node, context);
        }
      },
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
