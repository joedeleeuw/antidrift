import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  extractObjectFieldNames,
  resolveSchemaBuilderCall,
  resolveSchemaMemberChain,
  schemaDiscriminantKeys,
  staticPropertyName,
} from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

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
  const p = fnNode.parent;
  return (
    p?.type === "ExportNamedDeclaration" ||
    p?.type === "ExportDefaultDeclaration" ||
    p?.parent?.parent?.type === "ExportNamedDeclaration"
  );
}

function isUnexportedContractProjectionFunction(objNode, sourceIdent, context) {
  const fnNode = enclosingSingleReturnFunction(objNode);
  if (!fnNode || fnNode.params.length !== 1 || isExportedFunction(fnNode)) {
    return false;
  }
  const param = fnNode.params[0];
  if (param.type !== "Identifier" || param.name !== sourceIdent) {
    return false;
  }
  const paramType = param.typeAnnotation?.typeAnnotation;
  const returnType = fnNode.returnType?.typeAnnotation;
  if (
    paramType?.type !== "TSTypeReference" ||
    returnType?.type !== "TSTypeReference"
  ) {
    return false;
  }
  return (
    context.sourceCode.getText(paramType.typeName) !==
    context.sourceCode.getText(returnType.typeName)
  );
}

function checkContractProjection(node, context) {
  if (node.properties.length < 3) return;
  let sourceIdent = null;
  let allSameSource = true;
  for (const prop of node.properties) {
    if (
      prop.type !== "Property" ||
      prop.computed ||
      prop.shorthand ||
      prop.key?.type !== "Identifier"
    ) {
      allSameSource = false;
      break;
    }
    const val = unwrapExpression(prop.value);
    if (
      val?.type !== "MemberExpression" ||
      val.computed ||
      val.object?.type !== "Identifier" ||
      val.property?.type !== "Identifier" ||
      val.property.name !== prop.key.name
    ) {
      allSameSource = false;
      break;
    }
    if (sourceIdent === null) {
      sourceIdent = val.object.name;
    } else if (sourceIdent !== val.object.name) {
      allSameSource = false;
      break;
    }
  }
  if (
    allSameSource &&
    sourceIdent &&
    isUnexportedContractProjectionFunction(node, sourceIdent, context)
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
        "Disallow `{ ok, data, error }` product result envelopes and verbatim 3+ property bag clones `{ a: x.a, b: x.b, c: x.c }`.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      ObjectExpression(node) {
        checkContractProjection(node, context);
      },
      TSTypeLiteral(node) {
        const names = new Set();
        for (const m of node.members) {
          if (
            m.type === "TSPropertySignature" &&
            m.key?.type === "Identifier"
          ) {
            names.add(m.key.name);
          }
        }
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
      },
    };
  },
};

function shapeSignature(members, sourceCode) {
  if (!Array.isArray(members) || members.length < 3) return null;
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

function checkShape(context, seenShapes, name, members, reportNode) {
  const signature = shapeSignature(members, context.sourceCode);
  if (!signature) return;
  const existing = seenShapes.get(signature);
  if (existing && existing !== name) {
    context.report({
      node: reportNode,
      message: `Type '${name}' duplicates the exact ${members.length}-field shape of '${existing}'; reuse '${existing}' instead of forking a parallel contract.`,
    });
    return;
  }
  seenShapes.set(signature, name);
}

function objectSchemaTags(expression, sourceCode, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier") {
    const definition = findVariable(sourceCode, node)?.defs?.[0];
    if (definition?.parent?.kind !== "const" || seen.has(definition)) return [];
    seen.add(definition);
    return objectSchemaTags(definition.node.init, sourceCode, seen);
  }
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (
    builder?.method !== "object" ||
    builder.args[0]?.type !== "ObjectExpression"
  )
    return [];
  return builder.args[0].properties.flatMap((property) => {
    const name = staticPropertyName(property);
    if (!schemaDiscriminantKeys.has(name)) return [];
    const literal = resolveSchemaBuilderCall(property.value, sourceCode);
    return literal?.method === "literal" && literal.args[0]?.type === "Literal"
      ? [name]
      : [];
  });
}

function unionDiscriminants(expression, sourceCode) {
  const builder = resolveSchemaBuilderCall(
    unwrapExpression(expression),
    sourceCode
  );
  if (!builder) return [];
  const tagged = builder.method === "discriminatedUnion";
  let variants = [];
  if (tagged && builder.args[1]?.type === "ArrayExpression")
    variants = builder.args[1].elements;
  if (builder.method === "union") variants = builder.args;
  if (variants.length < 2) return [];
  const tags = variants.map((variant) => objectSchemaTags(variant, sourceCode));
  const candidates =
    tagged && builder.args[0]?.type === "Literal"
      ? [builder.args[0].value]
      : tags[0];
  return candidates.filter(
    (key) =>
      schemaDiscriminantKeys.has(key) &&
      tags.every((keys) => keys.includes(key))
  );
}

function checkSchemaExports(program, context) {
  const declarations = program.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement
    )
    .filter((declaration) => declaration?.type === "VariableDeclaration");
  const tags = new Set(
    declarations.flatMap((declaration) =>
      declaration.declarations.flatMap((binding) =>
        unionDiscriminants(binding.init, context.sourceCode)
      )
    )
  );
  if (tags.size === 0) return;
  for (const declaration of declarations) {
    if (
      declaration.kind !== "const" ||
      declaration.parent?.type !== "ExportNamedDeclaration"
    ) {
      continue;
    }
    for (const binding of declaration.declarations) {
      if (
        resolveSchemaBuilderCall(
          unwrapExpression(binding.init),
          context.sourceCode
        )?.method !== "object"
      ) {
        continue;
      }
      const tag = objectSchemaTags(binding.init, context.sourceCode).find(
        (key) => tags.has(key)
      );
      if (tag) {
        context.report({
          node: binding.id,
          message: `Exported variant schema duplicates the '${tag}' discriminant of a union in this module; derive variants from the canonical union instead of exporting parallel object schemas.`,
        });
      }
    }
  }
}

function checkSchemaRename(node, context) {
  if (
    node.callee?.type !== "MemberExpression" ||
    node.callee.property?.name !== "extend"
  )
    return;
  const chain = resolveSchemaMemberChain(node, context.sourceCode);
  const extended = chain?.steps.at(-1);
  const omitted = chain?.steps.at(-2);
  if (
    omitted?.method !== "omit" ||
    extended?.node !== node ||
    unwrapExpression(node.callee.object) !== omitted.node
  ) {
    return;
  }
  const omittedNames = extractObjectFieldNames(omitted.args[0]);
  const extendedNames = extractObjectFieldNames(extended.args[0]);
  if (
    omittedNames.length > 0 &&
    extendedNames.length > 0 &&
    omittedNames.every((name) => !extendedNames.includes(name))
  ) {
    context.report({
      node,
      message:
        "Schema `.omit().extend()` forks the schema shape by renaming fields; share a base schema or transform at the boundary.",
    });
  }
}

export const noStructuralTypeForkRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow duplicate 3+ field object type shapes within a module.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const seenShapes = new Map();
    return {
      Program(node) {
        checkSchemaExports(node, context);
      },
      CallExpression(node) {
        checkSchemaRename(node, context);
      },
      TSInterfaceDeclaration(node) {
        if (node.id?.name && (!node.extends || node.extends.length === 0)) {
          checkShape(
            context,
            seenShapes,
            node.id.name,
            node.body?.body,
            node.id
          );
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.id?.name && node.typeAnnotation?.type === "TSTypeLiteral") {
          checkShape(
            context,
            seenShapes,
            node.id.name,
            node.typeAnnotation.members,
            node.id
          );
        }
      },
    };
  },
};

export const noHypotheticalSeamRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow unexported single-implementation interfaces or injected default dependencies only overridden in tests.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const interfaces = new Map();
    const implementCounts = new Map();

    return {
      TSInterfaceDeclaration(node) {
        if (node.parent?.type === "ExportNamedDeclaration") return;
        if (
          node.id?.name &&
          node.body?.body?.some((m) => m.type === "TSMethodSignature")
        ) {
          interfaces.set(node.id.name, node);
        }
      },
      ClassDeclaration(node) {
        for (const impl of node.implements ?? []) {
          if (impl.expression?.type === "Identifier") {
            const name = impl.expression.name;
            implementCounts.set(name, (implementCounts.get(name) ?? 0) + 1);
          }
        }
      },
      "Program:exit"() {
        for (const [name, node] of interfaces) {
          if (implementCounts.get(name) === 1) {
            context.report({
              node: node.id,
              message: `Interface '${name}' has only one implementation in this module; delete the hypothetical seam until a second adapter exists.`,
            });
          }
        }
      },
    };
  },
};

export const noUnresolvedDependencyTypesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `@ts-expect-error` or `@ts-ignore` comments that suppress unresolved module or type imports.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const importLines = new Set();

    function markImportNode(node) {
      const startLine = node.loc?.start?.line;
      if (typeof startLine === "number") {
        importLines.add(startLine);
      }
    }

    return {
      ImportDeclaration: markImportNode,
      ExportAllDeclaration: markImportNode,
      ExportNamedDeclaration(node) {
        if (node.source) markImportNode(node);
      },
      TSImportType: markImportNode,
      "Program:exit"() {
        const comments = context.sourceCode.getAllComments?.() ?? [];
        for (const comment of comments) {
          if (!/@ts-(?:expect-error|ignore)/u.test(comment.value)) continue;
          const endLine = comment.loc?.end?.line;
          if (
            typeof endLine === "number" &&
            (importLines.has(endLine) || importLines.has(endLine + 1))
          ) {
            context.report({
              loc: comment.loc,
              message:
                "Do not suppress unresolved module or type imports with `@ts-expect-error` or `@ts-ignore`; declare or install the dependency types.",
            });
          }
        }
      },
    };
  },
};
