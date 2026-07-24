const defaultOptions = {
  minSharedFields: 2,
  minShapes: 2,
  minRedundantDeclarations: 3,
};
const optionKeys = new Set([
  "minSharedFields",
  "minShapes",
  "minRedundantDeclarations",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidOptions(message) {
  throw new TypeError(
    `antidrift/no-duplicated-object-field-blocks options: ${message}`,
  );
}

function requireKnownKeys(options) {
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key)) invalidOptions(`unknown option '${key}'.`);
  }
}

function requireOption(options, key) {
  if (!Object.hasOwn(options, key)) invalidOptions(`missing '${key}'.`);
  return options[key];
}

function boundedNumber(options, key, predicate, description) {
  const value = requireOption(options, key);
  if (typeof value !== "number" || !Number.isFinite(value) || !predicate(value)) {
    invalidOptions(`'${key}' must be ${description}.`);
  }
  return value;
}

function normalizeOptionShape(options) {
  requireKnownKeys(options);
  return {
    minSharedFields: boundedNumber(
      options,
      "minSharedFields",
      (value) => Number.isInteger(value) && value >= 1,
      "an integer greater than or equal to 1",
    ),
    minShapes: boundedNumber(
      options,
      "minShapes",
      (value) => Number.isInteger(value) && value >= 2,
      "an integer greater than or equal to 2",
    ),
    minRedundantDeclarations: boundedNumber(
      options,
      "minRedundantDeclarations",
      (value) => Number.isInteger(value) && value >= 1,
      "an integer greater than or equal to 1",
    ),
  };
}

function normalizedOptions(rawOptions) {
  if (rawOptions === undefined) return normalizeOptionShape(defaultOptions);
  if (!isRecord(rawOptions)) invalidOptions("must be an object.");
  return normalizeOptionShape(rawOptions);
}

function staticPropertyName(node) {
  if (node?.computed) return "";
  if (node?.key?.type === "Identifier") return node.key.name;
  if (node?.key?.type === "Literal" && typeof node.key.value === "string") {
    return node.key.value;
  }
  return "";
}

function normalizedSourceText(sourceCode, node) {
  return sourceCode.getText(node).replace(/\s+/gu, " ").trim();
}

function zodFields(shape, sourceCode) {
  const fields = [];
  for (const property of shape.properties) {
    if (property.type !== "Property") continue;
    const name = staticPropertyName(property);
    if (!name) continue;
    fields.push({
      key: `${name}\0${normalizedSourceText(sourceCode, property.value)}`,
      name,
    });
  }
  return fields;
}

function typeFields(shape, sourceCode) {
  const fields = [];
  const members = shape.type === "TSTypeLiteral" ? shape.members : shape.body;
  for (const member of members) {
    if (member.type !== "TSPropertySignature" || !member.typeAnnotation) continue;
    const name = staticPropertyName(member);
    if (!name) continue;
    fields.push({
      key: `${name}\0${normalizedSourceText(sourceCode, member.typeAnnotation)}`,
      name,
    });
  }
  return fields;
}

function fieldOccurrences(shapes, sourceCode, fieldsForShape) {
  const occurrences = new Map();
  shapes.forEach((shape, shapeIndex) => {
    const seen = new Set();
    for (const field of fieldsForShape(shape, sourceCode)) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      const occurrence = occurrences.get(field.key) ?? {
        name: field.name,
        shapeIndices: new Set(),
      };
      occurrence.shapeIndices.add(shapeIndex);
      occurrences.set(field.key, occurrence);
    }
  });
  return occurrences;
}

function cooccurrenceGroups(occurrences) {
  const groups = new Map();
  for (const [fieldKey, occurrence] of occurrences) {
    const shapeIndices = [...occurrence.shapeIndices];
    const signature = shapeIndices.join(",");
    const group = groups.get(signature) ?? {
      fieldKeys: [],
      fieldNames: [],
      shapeIndices,
    };
    group.fieldKeys.push(fieldKey);
    group.fieldNames.push(occurrence.name);
    groups.set(signature, group);
  }
  return [...groups.values()];
}

function candidateScore(candidate) {
  return candidate.fieldKeys.length * (candidate.shapeIndices.length - 1);
}

function qualifies(candidate, options) {
  return (
    candidate.fieldKeys.length >= options.minSharedFields &&
    candidate.shapeIndices.length >= options.minShapes &&
    candidateScore(candidate) >= options.minRedundantDeclarations
  );
}

function isSubset(left, right) {
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function isStrictSubsetOf(candidate, reported) {
  return (
    candidate.shapeIndices.length < reported.shapeIndices.length &&
    isSubset(candidate.shapeIndices, reported.shapeIndices)
  );
}

function reportedCandidates(groups, options) {
  const candidates = groups
    .filter((candidate) => qualifies(candidate, options));
  return candidates
    .filter(
      (candidate) =>
        !candidates.some((other) => isStrictSubsetOf(candidate, other)),
    )
    .sort(
      (left, right) =>
        candidateScore(right) - candidateScore(left) ||
        right.fieldKeys.length - left.fieldKeys.length ||
        right.shapeIndices.length - left.shapeIndices.length ||
        left.shapeIndices[0] - right.shapeIndices[0],
    );
}

function reportShapeKind(context, shapes, sourceCode, fieldsForShape, options) {
  const occurrences = fieldOccurrences(shapes, sourceCode, fieldsForShape);
  const groups = cooccurrenceGroups(occurrences);
  for (const candidate of reportedCandidates(groups, options)) {
    const fields = candidate.fieldNames.toSorted().slice(0, 6).join(", ");
    context.report({
      node: shapes[candidate.shapeIndices[0]],
      messageId: "duplicatedObjectFieldBlocks",
      data: {
        shapes: String(candidate.shapeIndices.length),
        count: String(candidate.fieldKeys.length),
        fields,
      },
    });
  }
}

function memberPropertyName(member) {
  if (member?.type !== "MemberExpression") return "";
  if (!member.computed && member.property?.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.computed &&
    member.property?.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return "";
}

function zodObjectShape(node) {
  if (memberPropertyName(node.callee) !== "object") return null;
  if (node.arguments.length !== 1) return null;
  const [shape] = node.arguments;
  return shape?.type === "ObjectExpression" ? shape : null;
}

export default function ruleNoDuplicatedObjectFieldBlocks() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow repeated field blocks across sibling Zod object and TypeScript object shapes",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "minSharedFields",
            "minShapes",
            "minRedundantDeclarations",
          ],
          properties: {
            minSharedFields: {
              type: "integer",
              minimum: 1,
            },
            minShapes: {
              type: "integer",
              minimum: 2,
            },
            minRedundantDeclarations: {
              type: "integer",
              minimum: 1,
            },
          },
        },
      ],
      messages: {
        duplicatedObjectFieldBlocks:
          "{{shapes}} object shapes repeat the same {{count}} fields ({{fields}}). Hoist the shared field block into one named shape and spread or extend it instead of repeating it.",
      },
    },
    create(context) {
      const options = normalizedOptions(context.options?.[0]);
      const sourceCode = context.sourceCode;
      const typeShapes = [];
      const zodShapes = [];
      return {
        CallExpression(node) {
          const shape = zodObjectShape(node);
          if (shape) zodShapes.push(shape);
        },
        TSTypeLiteral(node) {
          typeShapes.push(node);
        },
        TSInterfaceBody(node) {
          typeShapes.push(node);
        },
        "Program:exit"() {
          reportShapeKind(context, zodShapes, sourceCode, zodFields, options);
          reportShapeKind(context, typeShapes, sourceCode, typeFields, options);
        },
      };
    },
  };
}
