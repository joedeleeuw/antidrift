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

function createLineCapRule({ unitLabel, warnAbove, max, filterNode }) {
  const baseRule = {
    meta: {
      type: "problem",
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
  const nearRule = {
    meta: {
      type: "suggestion",
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
  return { baseRule, nearRule };
}

export const moduleLineCaps = createLineCapRule({
  unitLabel: "Module",
  warnAbove: 425,
  max: 500,
  filterNode: null,
});

export const functionLineCaps = createLineCapRule({
  unitLabel: "Function",
  warnAbove: 40,
  max: 50,
  filterNode: (node) => !functionReturnsJsx(node),
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
    const max = context.options[0]?.max ?? 12;
    const typeDeclarations = new Map();

    function hasWidgetDirective(fnNode) {
      if (fnNode?.body?.type !== "BlockStatement") return false;
      for (const stmt of fnNode.body.body) {
        if (stmt.type !== "ExpressionStatement") break;
        const dir =
          stmt.directive ??
          (stmt.expression?.type === "Literal" &&
          typeof stmt.expression.value === "string"
            ? stmt.expression.value
            : null);
        if (!dir) break;
        if (dir === "widget") return true;
      }
      return false;
    }

    function collectTypePropertyNames(
      typeNode,
      names = new Set(),
      seen = new Set()
    ) {
      if (!typeNode) return names;
      if (typeNode.type === "TSTypeLiteral") {
        for (const m of typeNode.members) {
          if (
            m.type === "TSPropertySignature" &&
            m.key?.type === "Identifier"
          ) {
            names.add(m.key.name);
          }
        }
        return names;
      }
      if (typeNode.type === "TSInterfaceBody") {
        for (const m of typeNode.body) {
          if (
            m.type === "TSPropertySignature" &&
            m.key?.type === "Identifier"
          ) {
            names.add(m.key.name);
          }
        }
        return names;
      }
      if (typeNode.type === "TSIntersectionType") {
        for (const part of typeNode.types) {
          collectTypePropertyNames(part, names, seen);
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
          names,
          seen
        );
      }
      return names;
    }

    function countTypeMembers(typeNode) {
      return collectTypePropertyNames(typeNode).size;
    }

    function checkComponent(node) {
      if (
        !functionReturnsJsx(node) ||
        hasWidgetDirective(node) ||
        node.params.length === 0 ||
        node.params.length > 2
      ) {
        return;
      }
      const first = node.params[0];
      let propCount = 0;
      if (first.type === "ObjectPattern") {
        propCount = first.properties.filter(
          (p) => p.type === "Property"
        ).length;
      }
      const annotationCount = countTypeMembers(
        first.typeAnnotation?.typeAnnotation
      );
      const total = Math.max(propCount, annotationCount);
      if (total > max) {
        context.report({
          node: first,
          message: `Component accepts ${total} props (max ${max}); group cohesive props or compose children instead.`,
        });
      }
    }

    return {
      Program(node) {
        for (const stmt of node.body) {
          const decl =
            stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
          if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
            typeDeclarations.set(decl.id.name, decl.body);
          } else if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
            typeDeclarations.set(decl.id.name, decl.typeAnnotation);
          }
        }
      },
      FunctionDeclaration: checkComponent,
      FunctionExpression: checkComponent,
      ArrowFunctionExpression: checkComponent,
    };
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
    return {
      IfStatement(node) {
        if (
          node.parent?.type === "IfStatement" &&
          node.parent.alternate === node
        ) {
          return;
        }
        let branches = 1;
        let cur = node;
        while (cur.alternate) {
          branches += 1;
          if (cur.alternate.type === "IfStatement") {
            cur = cur.alternate;
          } else {
            break;
          }
        }
        if (branches >= 5) {
          context.report({
            node,
            message: `Branch tree has ${branches} arms; declare a typed case table instead of chaining if/else branches.`,
          });
        }
      },
    };
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
          const variable = findVariable(sourceCode, decl.id);
          if (!variable) continue;
          const writes = variable.references.filter((r) => r.isWrite());
          if (
            writes.length >= 2 &&
            writes.every((w) => {
              for (let cur = w.identifier?.parent; cur; cur = cur.parent) {
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
    return {
      Program(node) {
        if (node.body.length === 0) return;
        const allReexports = node.body.every(
          (stmt) =>
            stmt.type === "ExportAllDeclaration" ||
            (stmt.type === "ExportNamedDeclaration" &&
              stmt.source !== null &&
              stmt.declaration === null)
        );
        if (!allReexports) return;
        if (
          stem &&
          node.body.length === 1 &&
          typeof node.body[0].source?.value === "string" &&
          node.body[0].source.value.includes(`${stem}.`)
        ) {
          return;
        }
        context.report({
          node,
          message:
            "Module only re-exports symbols from other modules; import from the owning module directly.",
        });
      },
    };
  },
};
