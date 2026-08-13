import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";

const EQUALITY_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toContain",
  "toContainEqual",
  "toHaveProperty",
]);

const EXISTENCE_MATCHERS = new Set([
  "toBeNull",
  "toBeUndefined",
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
]);

const CHAIN_MODIFIERS = new Set(["not", "resolves", "rejects"]);

const testFilenamePattern =
  /(?:(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.][cm]?[jt]sx?$)/u;

function contextFilename(context) {
  if (typeof context.getFilename === "function") return context.getFilename();
  return context.filename ?? "";
}

function isTestFilename(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") {
    return true;
  }
  return testFilenamePattern.test(filename);
}

function unwrap(node) {
  let current = node;
  while (current) {
    if (current.type === "ChainExpression") {
      current = current.expression;
    } else if (
      current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression"
    ) {
      current = current.expression;
    } else if (current.type === "AwaitExpression") {
      current = current.argument;
    } else {
      return current;
    }
  }
  return node;
}

function isLiteralLike(node) {
  const target = unwrap(node);
  if (!target) return false;
  switch (target.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return target.expressions.length === 0;
    case "Identifier":
      return target.name === "undefined";
    case "UnaryExpression":
      return (
        (target.operator === "-" || target.operator === "+") &&
        isLiteralLike(target.argument)
      );
    case "ObjectExpression":
      return target.properties.every(
        (property) =>
          property.type === "Property" &&
          !property.computed &&
          isLiteralLike(property.value),
      );
    case "ArrayExpression":
      return target.elements.every(
        (element) => element !== null && isLiteralLike(element),
      );
    default:
      return false;
  }
}

function expectCallOf(matcherCallee) {
  let receiver = unwrap(matcherCallee.object);
  while (
    receiver.type === "MemberExpression" &&
    !receiver.computed &&
    receiver.property.type === "Identifier" &&
    CHAIN_MODIFIERS.has(receiver.property.name)
  ) {
    receiver = unwrap(receiver.object);
  }
  if (
    receiver.type === "CallExpression" &&
    unwrap(receiver.callee).type === "Identifier" &&
    unwrap(receiver.callee).name === "expect" &&
    receiver.arguments.length > 0
  ) {
    return receiver;
  }
  return null;
}

export default function ruleNoRepoStateMirrorAssertion() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow test assertions that mirror repo-owned state (confs, manifests, registries) as literals instead of asserting behavior or invariants.",
      },
      schema: [
        {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  module: { type: "string" },
                  names: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["module"],
                additionalProperties: false,
              },
            },
          },
          required: ["sources"],
          additionalProperties: false,
        },
      ],
      messages: {
        mirroredLiteral:
          'This assertion mirrors repo-owned state loaded through "{{name}}" against a literal. It restates values the repo already defines and breaks on every legitimate tune. Assert an invariant or behavior, or arrange the data as a fixture the test owns.',
        pinnedLookup:
          'This assertion pins the presence of a specific key in repo-owned state via "{{name}}". A row existing is data, not behavior. Assert an invariant, or arrange the data as a fixture the test owns.',
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) return {};
      const sources = context.options?.[0]?.sources ?? [];
      if (sources.length === 0) return {};

      const sourceCode = context.sourceCode ?? context.getSourceCode?.();
      const taintedImports = new Map();
      const taintCache = new Map();

      function sourceForImport(moduleSpecifier, importedName) {
        for (const source of sources) {
          if (!moduleSpecifier.includes(source.module)) continue;
          if (!source.names || source.names.includes(importedName)) {
            return importedName;
          }
        }
        return null;
      }

      function variableIsTainted(variable) {
        if (taintCache.has(variable)) return taintCache.get(variable);
        taintCache.set(variable, false);

        let tainted = false;
        for (const def of variable.defs ?? []) {
          if (def.type === "ImportBinding") {
            tainted = taintedImports.has(variable.name);
          } else if (
            def.type === "Variable" &&
            def.node.type === "VariableDeclarator"
          ) {
            if (def.node.init) {
              tainted = expressionIsTainted(def.node.init);
            }
            if (
              !tainted &&
              def.node.parent?.parent?.type === "ForOfStatement" &&
              def.node.parent.parent.left === def.node.parent
            ) {
              tainted = expressionIsTainted(def.node.parent.parent.right);
            }
          } else if (def.type === "Parameter") {
            const fn = def.node;
            const call = fn.parent;
            if (
              call?.type === "CallExpression" &&
              call.arguments.includes(fn) &&
              call.callee.type === "MemberExpression"
            ) {
              tainted = expressionIsTainted(call.callee.object);
            }
          }
          if (tainted) break;
        }
        taintCache.set(variable, tainted);
        return tainted;
      }

      function expressionIsTainted(node) {
        return taintRootName(node) !== null;
      }

      function taintRootName(node) {
        const target = unwrap(node);
        if (!target) return null;
        switch (target.type) {
          case "Identifier": {
            const variable = findVariable(sourceCode, target);
            if (!variable) return null;
            if (taintedImports.has(target.name)) return target.name;
            return variableIsTainted(variable) ? target.name : null;
          }
          case "CallExpression":
            return taintRootName(target.callee);
          case "MemberExpression":
            return taintRootName(target.object);
          case "ConditionalExpression":
            return (
              taintRootName(target.consequent) ??
              taintRootName(target.alternate)
            );
          case "LogicalExpression":
            return taintRootName(target.left) ?? taintRootName(target.right);
          default:
            return null;
        }
      }

      function literalKeyedSourceCall(node) {
        const target = unwrap(node);
        if (!target) return null;
        if (target.type === "CallExpression") {
          const callee = unwrap(target.callee);
          if (
            callee.type === "Identifier" &&
            taintedImports.has(callee.name) &&
            target.arguments.length > 0 &&
            target.arguments.every((argument) => isLiteralLike(argument))
          ) {
            return callee.name;
          }
          return literalKeyedSourceCall(target.callee);
        }
        if (target.type === "MemberExpression") {
          return literalKeyedSourceCall(target.object);
        }
        return null;
      }

      return {
        ImportDeclaration(node) {
          const moduleSpecifier = node.source.value;
          if (typeof moduleSpecifier !== "string") return;
          for (const specifier of node.specifiers) {
            const importedName =
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.local.name;
            const matched = sourceForImport(moduleSpecifier, importedName);
            if (matched) {
              taintedImports.set(specifier.local.name, matched);
            }
          }
        },
        CallExpression(node) {
          if (
            node.callee.type !== "MemberExpression" ||
            node.callee.computed ||
            node.callee.property.type !== "Identifier"
          ) {
            return;
          }
          const matcher = node.callee.property.name;
          const isEquality = EQUALITY_MATCHERS.has(matcher);
          const isExistence = EXISTENCE_MATCHERS.has(matcher);
          if (!isEquality && !isExistence) return;

          const expectCall = expectCallOf(node.callee);
          if (!expectCall) return;
          const subject = expectCall.arguments[0];

          if (isEquality) {
            if (node.arguments.length === 0) return;
            if (!node.arguments.every((argument) => isLiteralLike(argument))) {
              return;
            }
            const name = taintRootName(subject);
            if (name) {
              context.report({
                node,
                messageId: "mirroredLiteral",
                data: { name },
              });
            }
            return;
          }

          const pinned = literalKeyedSourceCall(subject);
          if (pinned) {
            context.report({
              node,
              messageId: "pinnedLookup",
              data: { name: pinned },
            });
          }
        },
      };
    },
  };
}
