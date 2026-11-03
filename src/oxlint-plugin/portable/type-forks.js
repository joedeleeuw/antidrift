import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  isObjectSchemaMethod,
  isSchemaFieldRename,
  objectSchemaTagPairs,
  resolveSchemaBuilderCall,
  unionDiscriminantPairs,
} from "../shared/runtime-schema-libraries.js";
import { isFunctionLike, unwrapExpression } from "../shared/scope.js";

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

function isUnexportedContractProjectionFunction(objNode, sourceIdent, context) {
  const fnNode = enclosingSingleReturnFunction(objNode);
  if (!fnNode || fnNode.params.length !== 1 || isExportedFunction(fnNode)) {
    return false;
  }
  const parameter = fnNode.params[0];
  if (parameter.type !== "Identifier" || parameter.name !== sourceIdent) {
    return false;
  }
  const paramType = parameter.typeAnnotation?.typeAnnotation;
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
    const member = unwrapExpression(prop.value);
    if (
      member?.type !== "MemberExpression" ||
      member.computed ||
      member.object?.type !== "Identifier" ||
      member.property?.type !== "Identifier" ||
      member.property.name !== prop.key.name
    ) {
      allSameSource = false;
      break;
    }
    if (sourceIdent === null) {
      sourceIdent = member.object.name;
    } else if (sourceIdent !== member.object.name) {
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
        for (const member of node.members) {
          if (
            member.type === "TSPropertySignature" &&
            member.key?.type === "Identifier"
          ) {
            names.add(member.key.name);
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

function checkSchemaExports(program, context) {
  const sourceCode = context.sourceCode;
  const declarations = program.body
    .map((stmt) =>
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt
    )
    .filter((decl) => decl?.type === "VariableDeclaration");
  const memberDeclarators = new Set();
  const unionPairs = new Set(
    declarations.flatMap((decl) =>
      decl.declarations.flatMap((binding) =>
        unionDiscriminantPairs(binding.init, sourceCode, memberDeclarators)
      )
    )
  );
  if (unionPairs.size === 0) return;
  for (const decl of declarations) {
    if (
      decl.kind !== "const" ||
      decl.parent?.type !== "ExportNamedDeclaration"
    ) {
      continue;
    }
    for (const binding of decl.declarations) {
      const builder = resolveSchemaBuilderCall(
        unwrapExpression(binding.init),
        sourceCode
      );
      if (
        memberDeclarators.has(binding) ||
        !isObjectSchemaMethod(builder?.method)
      ) {
        continue;
      }
      const hit = objectSchemaTagPairs(binding.init, sourceCode).find((entry) =>
        unionPairs.has(entry.pair)
      );
      if (hit) {
        context.report({
          node: binding.id,
          message: `Exported variant schema duplicates the '${hit.key}' discriminant of a union in this module; derive variants from the canonical union instead of exporting parallel object schemas.`,
        });
      }
    }
  }
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

export const noStructuralTypeForkRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow duplicate 3+ field object type shapes, parallel exported union variant schemas, and `.omit().extend()` schema field renames.",
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
          node.body?.body?.some((member) => member.type === "TSMethodSignature")
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

const AMBIENT_RUNTIME_GLOBALS = new Set(["process", "Buffer", "NodeJS"]);

function isAmbientDeclarationFile(filename) {
  return (
    filename.endsWith(".d.ts") ||
    filename.endsWith(".d.mts") ||
    filename.endsWith(".d.cts")
  );
}

function checkAmbientProcessDeclaration(node, filename, context) {
  if (isAmbientDeclarationFile(filename) || node.declare !== true) {
    return;
  }
  for (const declarator of node.declarations) {
    const name = declarator.id?.type === "Identifier" ? declarator.id.name : "";
    if (AMBIENT_RUNTIME_GLOBALS.has(name)) {
      context.report({
        node: declarator,
        message: `Do not redeclare ambient '${name}' types inline; import the typed environment owner or install the runtime types.`,
      });
    }
  }
}

function checkAmbientModuleDeclaration(node, filename, context) {
  const name = node.id?.type === "Identifier" ? node.id.name : "";
  if (
    !isAmbientDeclarationFile(filename) &&
    node.declare === true &&
    AMBIENT_RUNTIME_GLOBALS.has(name)
  ) {
    context.report({
      node,
      message: `Do not redeclare ambient '${name}' types inline; import the typed environment owner or install the runtime types.`,
    });
  }
}

export const noUnresolvedDependencyTypesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `@ts-expect-error`/`@ts-ignore` import suppressions and inline ambient redeclarations of runtime globals (`process`, `Buffer`, `NodeJS`).",
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
    const filename = (
      context.filename ??
      context.getFilename?.() ??
      ""
    ).replaceAll("\\", "/");
    const importLines = new Set();

    function markImportNode(node) {
      const startLine = node.loc?.start?.line;
      if (typeof startLine === "number") {
        importLines.add(startLine);
      }
    }

    return {
      VariableDeclaration(node) {
        checkAmbientProcessDeclaration(node, filename, context);
      },
      TSModuleDeclaration(node) {
        checkAmbientModuleDeclaration(node, filename, context);
      },
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
