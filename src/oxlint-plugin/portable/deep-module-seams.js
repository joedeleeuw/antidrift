import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { functionReturnsJsx } from "../shared/scope.js";

function collectTypePropertyNames(
  typeNode,
  typeDeclarations,
  names = new Set(),
  seen = new Set()
) {
  if (!typeNode) return names;
  if (typeNode.type === "TSTypeLiteral") {
    for (const member of typeNode.members) {
      if (
        (member.type === "TSPropertySignature" ||
          member.type === "TSMethodSignature") &&
        member.key?.type === "Identifier"
      ) {
        names.add(member.key.name);
      }
    }
    return names;
  }
  if (typeNode.type === "TSInterfaceBody") {
    for (const member of typeNode.body) {
      if (
        (member.type === "TSPropertySignature" ||
          member.type === "TSMethodSignature") &&
        member.key?.type === "Identifier"
      ) {
        names.add(member.key.name);
      }
    }
    return names;
  }
  if (typeNode.type === "TSIntersectionType") {
    for (const part of typeNode.types) {
      collectTypePropertyNames(part, typeDeclarations, names, seen);
    }
    return names;
  }
  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    !seen.has(typeNode.typeName.name)
  ) {
    seen.add(typeNode.typeName.name);
    collectTypePropertyNames(
      typeDeclarations.get(typeNode.typeName.name),
      typeDeclarations,
      names,
      seen
    );
  }
  return names;
}

function recordProgramTypeDeclarations(programNode, typeDeclarations) {
  for (const stmt of programNode.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.body);
    } else if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.typeAnnotation);
    }
  }
}

function parameterPropertyNames(param, typeDeclarations) {
  const names = new Set();
  if (param.type === "ObjectPattern") {
    for (const prop of param.properties) {
      if (prop.type === "Property" && prop.key?.type === "Identifier") {
        names.add(prop.key.name);
      }
    }
  }
  collectTypePropertyNames(
    param.typeAnnotation?.typeAnnotation,
    typeDeclarations,
    names
  );
  return names;
}

export const noWideParameterBagsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow non-component functions whose parameter bag exceeds the maximum property count.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          max: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const max = context.options[0]?.max ?? 10;
    const typeDeclarations = new Map();

    function checkFunction(node) {
      if (functionReturnsJsx(node) || node.params.length === 0) return;
      for (const param of node.params) {
        if (
          param.type !== "ObjectPattern" &&
          param.typeAnnotation?.typeAnnotation?.type !== "TSTypeLiteral"
        ) {
          continue;
        }
        const names = parameterPropertyNames(param, typeDeclarations);
        if (names.size > max) {
          context.report({
            node: param,
            message: `Function parameter bag accepts ${names.size} properties (max ${max}); group cohesive domain concepts or move behavior onto the owning object.`,
          });
        }
      }
    }

    return {
      Program(node) {
        recordProgramTypeDeclarations(node, typeDeclarations);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noForeignStateCallbacksRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow non-component functions that accept multiple foreign state mutator/accessor callbacks (`setX`, `getX`) in a parameter bag.",
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
    const typeDeclarations = new Map();

    function checkFunction(node) {
      if (functionReturnsJsx(node) || node.params.length === 0) return;
      for (const param of node.params) {
        const names = parameterPropertyNames(param, typeDeclarations);
        if (names.size < 3) continue;
        const setters = [...names].filter((n) => /^set[A-Z]/u.test(n));
        const getters = [...names].filter((n) => /^get[A-Z]/u.test(n));
        if (
          setters.length >= 3 ||
          (setters.length >= 2 && getters.length >= 1)
        ) {
          const sample = [...setters, ...getters].slice(0, 4).join(", ");
          context.report({
            node: param,
            message: `Parameter bag accepts multiple foreign state callbacks (${sample}); return a state transition value or move the logic into the state owner.`,
          });
        }
      }
    }

    return {
      Program(node) {
        recordProgramTypeDeclarations(node, typeDeclarations);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};
