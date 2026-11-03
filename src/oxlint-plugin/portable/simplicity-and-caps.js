import { createBranchChecks } from "./branch-and-ternary-checks.js";
import { createComponentPropChecks } from "./component-prop-checks.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
} from "../shared/scope.js";

function nonBlankLineCount(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

function createBaseLineCapRule(cap, capSchema) {
  const { unitLabel, max: defaultMax, filterNode } = cap;
  return {
    meta: {
      type: "problem",
      schema: capSchema,
    },
    create(context) {
      if (!isRuleFile(context)) return {};
      const max = context.options[0]?.max ?? defaultMax;
      const sourceCode = context.sourceCode;
      if (!filterNode) {
        return {
          Program(node) {
            const count = nonBlankLineCount(sourceCode.text);
            if (count > max) {
              context.report({
                node,
                message: `${unitLabel} has ${count} non-blank lines (max ${max}); split along a domain seam.`,
              });
            }
          },
        };
      }
      function check(node) {
        if (!filterNode(node)) return;
        const count = nonBlankLineCount(sourceCode.getText(node));
        if (count > max) {
          context.report({
            node,
            message: `${unitLabel} has ${count} non-blank lines (max ${max}); split or deepen the module.`,
          });
        }
      }
      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  };
}

function createNearLineCapRule(cap, capSchema) {
  const {
    unitLabel,
    max: defaultMax,
    warnAbove: defaultWarnAbove,
    filterNode,
  } = cap;
  return {
    meta: {
      type: "suggestion",
      schema: capSchema,
    },
    create(context) {
      if (!isRuleFile(context)) return {};
      const max = context.options[0]?.max ?? defaultMax;
      const warnAbove = context.options[0]?.warnAbove ?? defaultWarnAbove;
      const sourceCode = context.sourceCode;
      if (!filterNode) {
        return {
          Program(node) {
            const count = nonBlankLineCount(sourceCode.text);
            if (count > warnAbove && count <= max) {
              context.report({
                node,
                message: `${unitLabel} has ${count} non-blank lines (warn above ${warnAbove}, max ${max}).`,
              });
            }
          },
        };
      }
      function check(node) {
        if (!filterNode(node)) return;
        const count = nonBlankLineCount(sourceCode.getText(node));
        if (count > warnAbove && count <= max) {
          context.report({
            node,
            message: `${unitLabel} has ${count} non-blank lines (warn above ${warnAbove}, max ${max}).`,
          });
        }
      }
      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  };
}

function createLineCapRule({
  unitLabel,
  warnAbove: defaultWarnAbove,
  max: defaultMax,
  filterNode,
}) {
  const capSchema = [
    {
      type: "object",
      properties: {
        ...scopeProperties,
        max: { type: "number" },
        warnAbove: { type: "number" },
      },
      additionalProperties: false,
    },
  ];
  const cap = {
    unitLabel,
    max: defaultMax,
    warnAbove: defaultWarnAbove,
    filterNode,
  };
  return {
    baseRule: createBaseLineCapRule(cap, capSchema),
    nearRule: createNearLineCapRule(cap, capSchema),
  };
}

export const moduleLineCaps = createLineCapRule({
  unitLabel: "Module",
  warnAbove: 425,
  max: 500,
  filterNode: null,
});

const TEST_SUITE_CALLEES = new Set(["describe", "suite", "context"]);

function isTestSuiteCallback(node) {
  const parent = node.parent;
  if (parent?.type !== "CallExpression" || !parent.arguments.includes(node)) {
    return false;
  }
  const callee = parent.callee;
  if (callee?.type === "Identifier") {
    return TEST_SUITE_CALLEES.has(callee.name);
  }
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    TEST_SUITE_CALLEES.has(callee.object.name)
  );
}

export const functionLineCaps = createLineCapRule({
  unitLabel: "Function",
  warnAbove: 40,
  max: 50,
  filterNode: (node) => !functionReturnsJsx(node) && !isTestSuiteCallback(node),
});

export const componentLineCaps = createLineCapRule({
  unitLabel: "Component",
  warnAbove: 150,
  max: 175,
  filterNode: (node) => functionReturnsJsx(node),
});

export const reactMaxComponentPropsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow React components with more than 7 props.",
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
    return createComponentPropChecks(context);
  },
};

export const noBranchTreeRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow deep if/else branch trees over a closed discriminant; use a typed case table.",
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
    return createBranchChecks(context);
  },
};

export const noMutableLetAliasRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow mutable let bindings that are only assigned across if/else branches.",
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
    const sourceCode = context.sourceCode;
    return {
      VariableDeclaration(node) {
        if (node.kind !== "let") return;
        for (const decl of node.declarations) {
          if (decl.id?.type !== "Identifier" || decl.init !== null) continue;
          const binding = findVariable(sourceCode, decl.id);
          if (!binding) continue;
          const writes = binding.references.filter((reference) =>
            reference.isWrite()
          );
          if (
            writes.length >= 2 &&
            writes.every((write) => {
              for (let cur = write.identifier?.parent; cur; cur = cur.parent) {
                if (cur.type === "IfStatement") return true;
                if (
                  isFunctionLike(cur) ||
                  cur.type === "ForStatement" ||
                  cur.type === "WhileStatement" ||
                  cur.type === "ForOfStatement" ||
                  cur.type === "TryStatement"
                ) {
                  return false;
                }
              }
              return false;
            })
          ) {
            context.report({
              node: decl,
              message: `Mutable binding '${decl.id.name}' is only assigned across conditional branches; compute a const expression or helper instead.`,
            });
          }
        }
      },
    };
  },
};

const PLATFORM_SUFFIXES = ["ios", "android", "native", "web", "electron"];
const MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

function hasPlatformSibling(filename, stem) {
  if (!stem || !filename.startsWith("/")) return false;
  const dir = dirname(filename);
  for (const suffix of PLATFORM_SUFFIXES) {
    for (const ext of MODULE_EXTS) {
      if (existsSync(join(dir, `${stem}.${suffix}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

function isOwnSliceReexport(stem, stmt) {
  if (!stem || typeof stmt.source?.value !== "string") return false;
  const src = stmt.source.value;
  return src.startsWith(`./${stem}.`) || src.startsWith(`./${stem}-`);
}

function checkReexports(node, stem, context) {
  if (node.body.length === 0) return;
  const allReexports = node.body.every(
    (stmt) =>
      stmt.type === "ExportAllDeclaration" ||
      (stmt.type === "ExportNamedDeclaration" &&
        stmt.source !== null &&
        stmt.declaration === null)
  );
  if (allReexports) {
    if (node.body.every((stmt) => isOwnSliceReexport(stem, stmt))) {
      return;
    }
    context.report({
      node,
      message:
        "Module only re-exports symbols from other modules; import from the owning module directly.",
    });
    return;
  }
  for (const stmt of node.body) {
    if (
      stmt.type === "ExportNamedDeclaration" &&
      stmt.declaration === null &&
      stmt.exportKind !== "type" &&
      typeof stmt.source?.value === "string" &&
      stmt.source.value.startsWith("./") &&
      !isOwnSliceReexport(stem, stmt) &&
      stmt.specifiers.some((spec) => spec.exportKind !== "type")
    ) {
      context.report({
        node: stmt,
        message:
          "Do not re-export runtime symbols from a relative sibling in a non-index module; import from the owning module directly.",
      });
    }
  }
}

export const noReexportOnlyModuleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow barrel or shim modules whose only statements are re-exports.",
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
    if (
      /\/index\.[cm]?[jt]sx?$/u.test(filename) ||
      /(?:^|\/)[^/]+\.config\.[cm]?[jt]sx?$/u.test(filename) ||
      /\.(?:ios|android|native|web|electron)\.[cm]?[jt]sx?$/u.test(filename) ||
      /(?:^|\/)app\/.*\.[cm]?[jt]sx?$/u.test(filename)
    ) {
      return {};
    }
    const baseMatch = filename.match(/\/([^/]+)\.[cm]?[jt]sx?$/u);
    const stem = baseMatch ? baseMatch[1] : null;
    if (hasPlatformSibling(filename, stem)) return {};
    return {
      Program(node) {
        checkReexports(node, stem, context);
      },
    };
  },
};
