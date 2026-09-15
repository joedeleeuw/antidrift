import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import {
  exportedArrays,
  importedArrays,
  memberSet,
} from "../owned-union-source.js";

function literalValue(node) {
  if (node?.type === "TSLiteralType") return literalValue(node.literal);
  if (
    node?.type === "Literal" &&
    ["string", "number"].includes(typeof node.value)
  ) {
    return node.value;
  }
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "-" &&
    typeof node.argument.value === "number"
  ) {
    return -node.argument.value;
  }
  return null;
}

function convexMethod(node, method, sourceCode) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed
  ) {
    return null;
  }
  const { object, property } = node.callee;
  if (object.type !== "Identifier" || property.name !== method) return null;
  const variable = findVariable(sourceCode, object);
  const definition = variable?.defs[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.node.type !== "ImportSpecifier"
  ) {
    return null;
  }
  const declaration = definition.parent;
  if (
    declaration.source.value !== "convex/values" ||
    declaration.importKind === "type" ||
    definition.node.importKind === "type"
  ) {
    return null;
  }
  return definition.node.imported.name === "v" ? variable : null;
}

function validatorMembers(node, sourceCode) {
  const receiver = convexMethod(node, "union", sourceCode);
  if (!receiver || node.arguments.length < 2) return null;
  return memberSet(
    node.arguments.map((argument) => {
      if (
        convexMethod(argument, "literal", sourceCode) !== receiver ||
        argument.arguments.length !== 1
      ) {
        return null;
      }
      return literalValue(argument.arguments[0]);
    }),
  );
}

function callSite(node) {
  const segments = [];
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (current.type === "Property" && !current.computed) {
      segments.unshift(current.key.name ?? current.key.value);
    }
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier"
    ) {
      segments.unshift(current.id.name);
      return segments.join(".");
    }
    if (
      [
        "FunctionDeclaration",
        "ArrowFunctionExpression",
        "FunctionExpression",
      ].includes(current.type)
    ) {
      break;
    }
  }
  return null;
}

function scopeVariable(sourceCode, node, name) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    if (scope.set.has(name)) return scope.set.get(name);
    scope = scope.upper;
  }
  return null;
}

function localOwnerVariable(program, sourceCode, name) {
  for (const statement of program.body) {
    const declaration = statement.declaration ?? statement;
    if (declaration.type !== "VariableDeclaration") continue;
    const owner = declaration.declarations.find(
      (entry) => entry.id.type === "Identifier" && entry.id.name === name,
    );
    if (owner) return findVariable(sourceCode, owner.id);
  }
  return null;
}

function importOwners(statement, context, cache) {
  if (statement.importKind === "type") return [];
  const arrays = importedArrays(
    context.filename,
    statement.source.value,
    cache,
  );
  return statement.specifiers.flatMap((specifier) => {
    if (specifier.importKind === "type") return [];
    const variable = findVariable(context.sourceCode, specifier.local);
    if (specifier.type === "ImportNamespaceSpecifier") {
      return arrays
        .filter((array) => array.name !== "default")
        .map((array) => ({
          ...array,
          name: `${specifier.local.name}.${array.name}`,
          binding: specifier.local.name,
          variable,
        }));
    }
    const imported =
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : (specifier.imported.name ?? specifier.imported.value);
    return arrays
      .filter((array) => array.name === imported)
      .map((array) => ({
        ...array,
        name: specifier.local.name,
        binding: specifier.local.name,
        variable,
      }));
  });
}

export default function ruleNoRedeclaredOwnedUnion() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require literal unions to derive from an in-scope owning runtime array.",
      },
      schema: [
        {
          type: "object",
          properties: {
            allows: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
            },
          },
          additionalProperties: false,
        },
      ],
      messages: {
        redeclaredOwner:
          "This union re-declares an owned string space; derive it from the owning runtime array {{owner}}.",
      },
    },
    create(context) {
      const sourceCode = context.sourceCode;
      const allows = new Set(context.options[0]?.allows ?? []);
      let owners = [];
      function report(node, members, name) {
        if (!members || allows.has(name)) return;
        const owner = owners.find(
          (candidate) =>
            candidate.members === members &&
            candidate.variable &&
            scopeVariable(sourceCode, node, candidate.binding) ===
              candidate.variable,
        );
        if (owner) {
          context.report({
            node,
            messageId: "redeclaredOwner",
            data: { owner: owner.name },
          });
        }
      }
      return {
        Program(node) {
          const cache = new Map();
          owners = exportedArrays(context.filename, sourceCode.text).map(
            (array) => ({
              ...array,
              name: array.local,
              binding: array.local,
              variable: localOwnerVariable(node, sourceCode, array.local),
            }),
          );
          for (const statement of node.body) {
            if (statement.type === "ImportDeclaration") {
              owners.push(...importOwners(statement, context, cache));
            }
          }
        },
        TSTypeAliasDeclaration(node) {
          if (node.typeAnnotation.type !== "TSUnionType") return;
          report(
            node.typeAnnotation,
            memberSet(node.typeAnnotation.types.map(literalValue)),
            node.id.name,
          );
        },
        CallExpression(node) {
          report(node, validatorMembers(node, sourceCode), callSite(node));
        },
      };
    },
  };
}
