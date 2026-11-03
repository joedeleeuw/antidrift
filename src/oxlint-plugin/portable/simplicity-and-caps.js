import { createBranchChecks } from "./branch-and-ternary-checks.js";
import { createComponentPropChecks } from "./component-prop-checks.js";
import {
  checkReexports,
  hasPlatformSibling,
  isDeclaredPackageIndex,
  nonBlankLineCount,
} from "./reexport-and-ceremony-checks.js";
import {
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
} from "../shared/scope.js";

const SCRIPT_PATH_RE = /(?:^|\/)(?:scripts|bin)\//u;

function createFunctionCapVisitors(
  sourceCode,
  filename,
  max,
  unitLabel,
  filterNode,
  context
) {
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
  function checkTopLevelScriptLoop(node) {
    if (
      unitLabel !== "Function" ||
      node.parent?.type !== "Program" ||
      !SCRIPT_PATH_RE.test(filename)
    ) {
      return;
    }
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
    ForOfStatement: checkTopLevelScriptLoop,
    ForStatement: checkTopLevelScriptLoop,
    WhileStatement: checkTopLevelScriptLoop,
  };
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
      return createFunctionCapVisitors(
        sourceCode,
        ruleFilename(context),
        max,
        unitLabel,
        filterNode,
        context
      );
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
        "Disallow deep if/else branch trees over a closed discriminant, discriminated-union ternary shredding, and repeated nullable ternary fan-out.",
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

const NON_BRANCH_CONTAINERS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
  "SwitchStatement",
]);

function isOnlyConditionalWrite(write, declarationContainer) {
  let sawIf = false;
  for (
    let cur = write.identifier?.parent;
    cur && cur !== declarationContainer;
    cur = cur.parent
  ) {
    if (cur.type === "IfStatement") {
      sawIf = true;
      continue;
    }
    if (isFunctionLike(cur) || NON_BRANCH_CONTAINERS.has(cur.type)) {
      return false;
    }
  }
  return sawIf;
}

function isStagedConstAlias(writes, reads, declarationContainer) {
  if (writes.length !== 1 || reads.length !== 1) return false;
  const writeStmt = writes[0].identifier?.parent?.parent;
  const readParent = reads[0].identifier?.parent;
  const readStmt = readParent?.parent;
  return (
    writeStmt?.type === "ExpressionStatement" &&
    writeStmt.parent === declarationContainer &&
    readParent?.type === "VariableDeclarator" &&
    readParent.init === reads[0].identifier &&
    readStmt?.type === "VariableDeclaration" &&
    readStmt.kind === "const" &&
    readStmt.parent === declarationContainer
  );
}

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
          const reads = binding.references.filter(
            (reference) => reference.isRead() && !reference.isWrite()
          );
          if (
            writes.length >= 2 &&
            writes.every((write) => isOnlyConditionalWrite(write, node.parent))
          ) {
            context.report({
              node: decl,
              message: `Mutable binding '${decl.id.name}' is only assigned across conditional branches; compute a const expression or helper instead.`,
            });
          } else if (isStagedConstAlias(writes, reads, node.parent)) {
            context.report({
              node: decl,
              message: `Mutable binding '${decl.id.name}' is only assigned once and aliased to a const; initialize the const binding directly.`,
            });
          }
        }
      },
    };
  },
};

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
    const filename = ruleFilename(context);
    if (
      isDeclaredPackageIndex(filename) ||
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
