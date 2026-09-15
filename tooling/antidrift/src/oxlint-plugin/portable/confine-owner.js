import { isRuleFile, scopeProperties } from "./scope.js";
import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
} from "./ast.js";

const GLOBAL_ROOTS = ["window", "globalThis", "self"];
const stringsFrom = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
const allowedPathsFrom = (entry, enforcement) => {
  const owner = stringsFrom(entry.owner);
  const allowed = enforcement.allowed;
  const allowedPaths = Array.isArray(allowed)
    ? allowed
        .map((item) =>
          typeof item === "object" && item !== null ? item.path : undefined,
        )
        .filter((item) => typeof item === "string")
    : [];
  return [...owner, ...allowedPaths];
};
const configuredEntries = (context) => {
  const importEntries = [];
  const globalMemberEntries = [];
  const options = context.options?.[0];
  if (typeof options !== "object" || options === null) {
    return { importEntries, globalMemberEntries };
  }
  const entries = options.entries;
  if (!Array.isArray(entries)) {
    return { importEntries, globalMemberEntries };
  }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const id = entry.id;
    const enforcement = entry.enforcement;
    if (typeof id !== "string") {
      continue;
    }
    if (typeof enforcement !== "object" || enforcement === null) {
      continue;
    }
    const owner = stringsFrom(entry.owner).join(", ");
    const paths = allowedPathsFrom(entry, enforcement);
    const kind = enforcement.kind;
    if (kind === "import") {
      importEntries.push({
        id,
        owner,
        paths,
        specifiers: stringsFrom(enforcement.specifiers),
      });
      continue;
    }
    if (kind === "global-member") {
      const object = enforcement.object;
      const memberPath = stringsFrom(enforcement.path);
      if (typeof object !== "string" || memberPath.length === 0) {
        continue;
      }
      globalMemberEntries.push({ id, owner, paths, object, memberPath });
    }
  }
  return { importEntries, globalMemberEntries };
};
const coversFile = (allowedPath, filename) =>
  allowedPath.endsWith("/")
    ? filename.includes(allowedPath)
    : filename.endsWith(allowedPath);
const specifierSuffix = (specifier) =>
  `/${specifier.split("/").slice(-2).join("/")}`;
const isOwnedSpecifier = (specifiers, source) => {
  if (typeof source !== "string") {
    return false;
  }
  return specifiers.some((specifier) => {
    const suffix = specifierSuffix(specifier);
    return (
      source === specifier ||
      source.endsWith(suffix) ||
      source.endsWith(`${suffix}.ts`)
    );
  });
};
const isGlobalObject = (node, object) =>
  isIdentifier(node, object) ||
  GLOBAL_ROOTS.some((root) => isMemberAccess(node, root, object));
const isMemberStep = (node, segment) =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.property, segment);
const isOwnedMemberPath = (node, object, memberPath) => {
  let current = node;
  for (const segment of memberPath.toReversed()) {
    if (!isMemberStep(current, segment)) {
      return false;
    }
    current = current.object;
  }
  return isGlobalObject(current, object);
};
export default {
  meta: {
    type: "problem",
    messages: {
      unownedUse:
        "`{{id}}` is owned by {{owner}}. Go through the owner, or add this file to that entry's `allowed` list with a reason in {{registry}}.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          registry: { type: "string", minLength: 1 },
          entries: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "owner", "enforcement"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1 },
                owner: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                enforcement: {
                  type: "object",
                  required: ["kind"],
                  oneOf: [
                    {
                      properties: { kind: { enum: ["import"] } },
                      required: ["specifiers"],
                    },
                    {
                      properties: { kind: { enum: ["global-member"] } },
                      required: ["object", "path"],
                    },
                  ],
                  additionalProperties: false,
                  properties: {
                    kind: { enum: ["import", "global-member"] },
                    specifiers: { type: "array", items: { type: "string" } },
                    object: { type: "string" },
                    path: { type: "array", items: { type: "string" } },
                    allowed: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["path", "reason"],
                        additionalProperties: false,
                        properties: {
                          path: { type: "string" },
                          reason: { type: "string", minLength: 1 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    let configured = null;
    let activeImports = [];
    let activeGlobalMembers = [];
    if (
      (() => {
        const filename = filenameForContext(context);
        configured ??= configuredEntries(context);
        const { importEntries, globalMemberEntries } = configured;
        const applies = (entry) =>
          !entry.paths.some((allowedPath) => coversFile(allowedPath, filename));
        activeImports = importEntries.filter(applies);
        activeGlobalMembers = globalMemberEntries.filter(applies);
        return activeImports.length > 0 || activeGlobalMembers.length > 0;
      })() === false
    ) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        for (const entry of activeImports) {
          if (isOwnedSpecifier(entry.specifiers, node.source.value)) {
            context.report({
              node,
              messageId: "unownedUse",
              data: {
                id: entry.id,
                owner: entry.owner,
                registry:
                  context.options[0]?.registry ??
                  "this rule’s entries configuration",
              },
            });
          }
        }
      },
      ImportExpression(node) {
        if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
          return;
        }
        for (const entry of activeImports) {
          if (isOwnedSpecifier(entry.specifiers, node.source.value)) {
            context.report({
              node,
              messageId: "unownedUse",
              data: {
                id: entry.id,
                owner: entry.owner,
                registry:
                  context.options[0]?.registry ??
                  "this rule’s entries configuration",
              },
            });
          }
        }
      },
      MemberExpression(node) {
        if (node.computed) {
          return;
        }
        for (const entry of activeGlobalMembers) {
          if (isOwnedMemberPath(node, entry.object, entry.memberPath)) {
            context.report({
              node,
              messageId: "unownedUse",
              data: {
                id: entry.id,
                owner: entry.owner,
                registry:
                  context.options[0]?.registry ??
                  "this rule’s entries configuration",
              },
            });
          }
        }
      },
    };
  },
};
