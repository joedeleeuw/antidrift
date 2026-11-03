import { basename } from "node:path";
import { checkDecodedBlobEquality } from "./boundary-decode-checks.js";
import { checkParallelSidecarMaps } from "./parallel-map-checks.js";
import {
  checkResultProductType,
  checkReturnContracts,
  constantEntries,
} from "./type-contracts.js";
import { topLevelTypeDeclarations } from "./type-predicate-checks.js";
import {
  checkIdentitySwitch,
  checkSchemaExports,
  checkUnionOwnership,
  createSeamVisitors,
} from "./type-fork-checks.js";
import { getProgramIndex } from "../shared/program-index.js";
import {
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import { isSchemaFieldRename } from "../shared/runtime-schema-libraries.js";
import {
  isFunctionLike,
  isTestFile,
  splitIdentifierWords,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

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

function isExportedFunction(fnNode) {
  const parent = fnNode.parent;
  return (
    parent?.type === "ExportNamedDeclaration" ||
    parent?.type === "ExportDefaultDeclaration" ||
    parent?.parent?.parent?.type === "ExportNamedDeclaration"
  );
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

function isUnexportedContractProjection(objNode, sourceIdent, sourceCode) {
  const fnNode = enclosingSingleReturnFunction(objNode);
  const parameter = fnNode?.params.length === 1 ? fnNode.params[0] : null;
  const paramType = parameter?.typeAnnotation?.typeAnnotation;
  const returnType = fnNode?.returnType?.typeAnnotation;
  return (
    parameter?.type === "Identifier" &&
    parameter.name === sourceIdent &&
    !isExportedFunction(fnNode) &&
    paramType?.type === "TSTypeReference" &&
    returnType?.type === "TSTypeReference" &&
    sourceCode.getText(paramType.typeName) !==
      sourceCode.getText(returnType.typeName)
  );
}

function checkContractProjection(node, context) {
  const sourceIdent =
    node.properties.length >= 3 ? projectionSource(node) : null;
  if (
    sourceIdent &&
    isUnexportedContractProjection(node, sourceIdent, context.sourceCode)
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
        "Disallow `{ ok, data, error }` product result envelopes, verbatim 3+ property bag clones, constant return fields, and complementary flag/error return products.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const checkFunction = (node) => checkReturnContracts(node, context);
    return {
      ObjectExpression(node) {
        checkContractProjection(node, context);
      },
      TSTypeLiteral(node) {
        checkResultProductType(node, context);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

function shapeSignature(members, sourceCode, minFields) {
  if (!Array.isArray(members) || members.length < minFields) return null;
  const fields = [];
  for (const member of members) {
    if (
      member.type !== "TSPropertySignature" ||
      member.computed ||
      member.key?.type !== "Identifier" ||
      !member.typeAnnotation?.typeAnnotation
    ) {
      return null;
    }
    const optional = member.optional ? "?" : "";
    const annotation = sourceCode
      .getText(member.typeAnnotation.typeAnnotation)
      .replace(/\s+/gu, " ");
    fields.push(`${member.key.name}${optional}:${annotation}`);
  }
  return fields.sort().join(";");
}

function checkShape(context, state, name, members, reportNode) {
  const signature = shapeSignature(
    members,
    context.sourceCode,
    state.fieldBlocks.minFields
  );
  if (!signature) return;
  const existing = state.seenShapes.get(signature);
  if (existing && existing !== name) {
    context.report({
      node: reportNode,
      message: `Type '${name}' duplicates the exact ${members.length}-field shape of '${existing}'; reuse '${existing}' instead of forking a parallel contract.`,
    });
    return;
  }
  state.seenShapes.set(signature, name);
}

function redundantOwnerStem(typeName, fieldNames) {
  const [stem, ...rest] = splitIdentifierWords(typeName);
  return fieldNames.length >= 3 &&
    rest.length > 0 &&
    stem.length >= 3 &&
    fieldNames.every(
      (field) =>
        field.startsWith(stem) && /^[A-Z]/u.test(field.slice(stem.length))
    )
    ? stem
    : null;
}

function checkProgramOwner(context, declaration, fieldNames, fieldBlocks) {
  const index = getProgramIndex(context.sourceCode);
  if (!index || fieldNames.length < fieldBlocks.minFields) {
    return;
  }
  const isExported = declaration.parent?.type === "ExportNamedDeclaration";
  const fieldKey = [...new Set(fieldNames)].sort().join(",");
  const filename = ruleFilename(context);
  if (
    isExported &&
    /(?:^|\/)(?:types|models|schemas|contracts|entities)\.[cm]?tsx?$/u.test(
      filename
    )
  ) {
    return;
  }
  const owners = index.exportedOwners.filter(
    (owner) =>
      owner.fieldKey === fieldKey &&
      owner.fileName !== filename &&
      /^[A-Z]/u.test(owner.name) &&
      (!isExported ||
        /(?:^|\/)(?:types|models|schemas|contracts|entities)\.[cm]?tsx?$/u.test(
          owner.fileName
        ))
  );
  if (owners.length === 0 || owners.length + 1 < fieldBlocks.minOccurrences) {
    return;
  }
  context.report({
    node: declaration.id,
    message: `Type '${declaration.id.name}' restates the ${fieldNames.length}-field shape of exported '${owners[0].name}' (${basename(owners[0].fileName)}); import that owner instead of forking a local copy.`,
  });
}

function checkTypeDeclaration(context, state, declaration, members) {
  const name = declaration.id.name;
  checkParallelSidecarMaps(context, name, members, declaration.id);
  if (declaration.extends?.length) return;
  checkShape(context, state, name, members, declaration.id);
  const fieldNames = (members ?? []).map((member) =>
    member.type === "TSPropertySignature" ? staticPropertyKey(member) : null
  );
  if (fieldNames.length === 0 || !fieldNames.every(Boolean)) return;
  const stem = redundantOwnerStem(name, fieldNames);
  if (stem) {
    context.report({
      node: declaration.id,
      message: `Type '${name}' prefixes all ${fieldNames.length} fields with '${stem}'; drop the redundant owner prefix from field names.`,
    });
  }
  checkProgramOwner(context, declaration, fieldNames, state.fieldBlocks);
}

function recordConstantLiteral(node, literalCounts) {
  const entries = constantEntries(node);
  if (
    entries.size < 3 ||
    entries.size !== node.properties.length ||
    node.parent?.type === "ArrayExpression" ||
    (node.parent?.type === "Property" && node.parent.value === node)
  ) {
    return;
  }
  const signature = [...entries]
    .map(([key, raw]) => `${key}=${raw}`)
    .sort()
    .join(";");
  const seen = literalCounts.get(signature);
  literalCounts.set(signature, {
    node: seen?.node ?? node,
    count: (seen?.count ?? 0) + 1,
  });
}

function checkSchemaRename(node, context) {
  if (isSchemaFieldRename(node, context.sourceCode)) {
    context.report({
      node,
      message:
        "Schema `.omit().extend()` forks the schema shape by renaming fields; share a base schema or transform at the boundary.",
    });
  }
}

function unionOwnershipVisitors(context, state) {
  return {
    Program(node) {
      state.typeDeclarations = topLevelTypeDeclarations(node);
      checkSchemaExports(node, context);
    },
    CallExpression(node) {
      checkSchemaRename(node, context);
      checkUnionOwnership(node, context, state.typeDeclarations);
    },
    TSUnionType(node) {
      checkUnionOwnership(node, context, state.typeDeclarations);
    },
    SwitchStatement(node) {
      checkIdentitySwitch(node, context);
    },
  };
}

function typeShapeVisitors(context, state) {
  return {
    BinaryExpression(node) {
      checkDecodedBlobEquality(node, context);
    },
    ObjectExpression(node) {
      if (!isTestFile(ruleFilename(context))) {
        recordConstantLiteral(node, state.literalCounts);
      }
    },
    TSInterfaceDeclaration(node) {
      if (node.id?.name) {
        checkTypeDeclaration(context, state, node, node.body?.body);
      }
    },
    TSTypeAliasDeclaration(node) {
      if (node.id?.name && node.typeAnnotation?.type === "TSTypeLiteral") {
        checkTypeDeclaration(context, state, node, node.typeAnnotation.members);
      }
    },
    ClassDeclaration(node) {
      if (node.id?.name) {
        checkParallelSidecarMaps(
          context,
          node.id.name,
          node.body?.body,
          node.id
        );
      }
    },
    "Program:exit"() {
      for (const { node, count } of state.literalCounts.values()) {
        if (count < 3) continue;
        context.report({
          node,
          message: `Identical constant object literal is repeated ${count} times in this module; extract a shared constant and reuse or spread it.`,
        });
      }
    },
  };
}

export const noStructuralTypeForkRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow forked type and schema shapes: duplicate or cross-file restated object types, degenerate or unfactored discriminated unions, identity discriminator switches, owner-prefixed fields, repeated constant literals, and decoded blobs that restate sibling columns.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          fieldBlocks: {
            type: "object",
            properties: {
              minFields: { type: "number" },
              minOccurrences: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const state = {
      fieldBlocks: {
        minFields: 3,
        minOccurrences: 2,
        ...context.options[0]?.fieldBlocks,
      },
      seenShapes: new Map(),
      literalCounts: new Map(),
      typeDeclarations: new Map(),
    };
    return {
      ...unionOwnershipVisitors(context, state),
      ...typeShapeVisitors(context, state),
    };
  },
};

export const noHypotheticalSeamRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow single-implementation interfaces and abstract seams, and effectful default parameters that no production caller overrides.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    return isRuleFile(context) ? createSeamVisitors(context) : {};
  },
};

const AMBIENT_RUNTIME_GLOBALS = new Set(["process", "Buffer", "NodeJS"]);

function checkAmbientRedeclaration(node, context) {
  if (node.declare !== true || /\.d\.[cm]?ts$/u.test(ruleFilename(context))) {
    return;
  }
  const targets =
    node.type === "VariableDeclaration"
      ? node.declarations.map((declarator) => [declarator, declarator.id])
      : [[node, node.id]];
  for (const [reportNode, id] of targets) {
    if (id?.type === "Identifier" && AMBIENT_RUNTIME_GLOBALS.has(id.name)) {
      context.report({
        node: reportNode,
        message: `Do not redeclare ambient '${id.name}' types inline; import the typed environment owner or install the runtime types.`,
      });
    }
  }
}

function reportImportSuppressions(context, importLines) {
  for (const comment of context.sourceCode.getAllComments?.() ?? []) {
    const endLine = comment.loc?.end?.line;
    if (
      /@ts-(?:expect-error|ignore)/u.test(comment.value) &&
      (importLines.has(endLine) || importLines.has(endLine + 1))
    ) {
      context.report({
        loc: comment.loc,
        message:
          "Do not suppress unresolved module or type imports with `@ts-expect-error` or `@ts-ignore`; declare or install the dependency types.",
      });
    }
  }
}

export const noUnresolvedDependencyTypesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `@ts-expect-error`/`@ts-ignore` import suppressions and inline ambient redeclarations of runtime globals (`process`, `Buffer`, `NodeJS`).",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const importLines = new Set();
    const markImportNode = (node) => importLines.add(node.loc?.start?.line);
    const checkAmbient = (node) => checkAmbientRedeclaration(node, context);
    return {
      VariableDeclaration: checkAmbient,
      TSModuleDeclaration: checkAmbient,
      ImportDeclaration: markImportNode,
      ExportAllDeclaration: markImportNode,
      ExportNamedDeclaration(node) {
        if (node.source) markImportNode(node);
      },
      TSImportType: markImportNode,
      "Program:exit"() {
        reportImportSuppressions(context, importLines);
      },
    };
  },
};
