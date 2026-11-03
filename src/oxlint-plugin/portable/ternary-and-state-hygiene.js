import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const DISCRIMINANT_KEYS = new Set([
  "kind",
  "type",
  "status",
  "tag",
  "_tag",
  "state",
  "mode",
  "phase",
  "variant",
]);

const HOOK_OR_COMPONENT_NAME = /^(?:use[A-Z0-9]|[A-Z])/u;

function isZeroLiteral(node) {
  const expr = unwrapExpression(node);
  return expr?.type === "Literal" && expr.value === 0;
}

function hasOptionalChain(node) {
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (expr.type === "ChainExpression") return true;
  if (expr.type === "MemberExpression" || expr.type === "CallExpression") {
    return (
      Boolean(expr.optional) || hasOptionalChain(expr.object ?? expr.callee)
    );
  }
  return false;
}

export const noOptionalChainZeroLengthInequalityRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `x?.y !== 0` or `x?.y != 0` comparisons where undefined short-circuits to true.",
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
      BinaryExpression(node) {
        if (node.operator !== "!==" && node.operator !== "!=") return;
        const leftChain =
          hasOptionalChain(node.left) && isZeroLiteral(node.right);
        const rightChain =
          hasOptionalChain(node.right) && isZeroLiteral(node.left);
        if (leftChain || rightChain) {
          context.report({
            node,
            message:
              "Optional-chain inequality against 0 evaluates to true when the chain short-circuits to undefined; use `(x?.length ?? 0) > 0` instead.",
          });
        }
      },
    };
  },
};

function enclosingUiFunction(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!isFunctionLike(cur)) continue;
    if (functionReturnsJsx(cur)) return cur;
    const name =
      cur.id?.name ??
      (cur.parent?.type === "VariableDeclarator" &&
      cur.parent.id?.type === "Identifier"
        ? cur.parent.id.name
        : null);
    if (name && HOOK_OR_COMPONENT_NAME.test(name)) return cur;
  }
  return null;
}

export const noModuleMutableUiStateRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow module-scope mutable UI state (`let` mutated inside components/hooks or module-scope `makeMutable(...)`).",
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
    if (!filename.endsWith(".tsx")) return {};
    const sourceCode = context.sourceCode;

    return {
      Program(programNode) {
        for (const stmt of programNode.body) {
          const decl =
            stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
          if (decl?.type !== "VariableDeclaration") continue;
          for (const declarator of decl.declarations) {
            if (declarator.id?.type !== "Identifier") continue;
            const init = unwrapExpression(declarator.init);
            if (
              init?.type === "CallExpression" &&
              init.callee?.type === "Identifier" &&
              init.callee.name === "makeMutable"
            ) {
              context.report({
                node: declarator,
                message: `Module-scope 'makeMutable' binding '${declarator.id.name}' shares mutable UI state across component instances; own the shared value inside a hook or context.`,
              });
              continue;
            }
            if (decl.kind !== "let") continue;
            const variable = findVariable(sourceCode, declarator.id);
            if (!variable) continue;
            const mutatedInUi = variable.references.some(
              (ref) =>
                ref.isWrite() && Boolean(enclosingUiFunction(ref.identifier))
            );
            if (mutatedInUi) {
              context.report({
                node: declarator,
                message: `Module-scope 'let ${declarator.id.name}' is mutated inside a React component or hook; move UI state into React state/context or a dedicated store.`,
              });
            }
          }
        }
      },
    };
  },
};

function isNullishNode(node) {
  const expr = unwrapExpression(node);
  return (
    (expr?.type === "Literal" && expr.value === null) ||
    (expr?.type === "Identifier" && expr.name === "undefined")
  );
}

function extractDiscriminantShred(initNode) {
  const expr = unwrapExpression(initNode);
  if (expr?.type !== "ConditionalExpression") return null;
  if (!isNullishNode(expr.alternate) && !isNullishNode(expr.consequent)) {
    return null;
  }
  const test = unwrapExpression(expr.test);
  if (
    test?.type !== "BinaryExpression" ||
    (test.operator !== "===" && test.operator !== "!==")
  ) {
    return null;
  }
  let member = null;
  if (test.left?.type === "MemberExpression") {
    member = test.left;
  } else if (test.right?.type === "MemberExpression") {
    member = test.right;
  }
  const literal = member === test.left ? test.right : test.left;
  if (
    !member ||
    member.computed ||
    member.object?.type !== "Identifier" ||
    member.property?.type !== "Identifier" ||
    !DISCRIMINANT_KEYS.has(member.property.name) ||
    literal?.type !== "Literal" ||
    typeof literal.value !== "string"
  ) {
    return null;
  }
  return {
    baseName: member.object.name,
    discKey: member.property.name,
    literalValue: literal.value,
  };
}

export const noShreddedDiscriminatedUnionRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow shredding a discriminated union into 2+ parallel nullable bindings via ternaries in the same block.",
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
      BlockStatement(blockNode) {
        const byBase = new Map();
        for (const stmt of blockNode.body) {
          if (stmt.type !== "VariableDeclaration") continue;
          for (const decl of stmt.declarations) {
            if (decl.id?.type !== "Identifier" || !decl.init) continue;
            const shred = extractDiscriminantShred(decl.init);
            if (!shred) continue;
            const key = `${shred.baseName}.${shred.discKey}`;
            const entry = byBase.get(key) ?? {
              baseName: shred.baseName,
              literals: new Set(),
            };
            entry.literals.add(shred.literalValue);
            byBase.set(key, entry);
            if (entry.literals.size === 2) {
              context.report({
                node: decl,
                message: `Discriminated union '${shred.baseName}' is shredded into parallel nullable bindings; narrow '${shred.baseName}' once via switch or a case table instead.`,
              });
            }
          }
        }
      },
    };
  },
};

function testedNullableIdentifier(condNode) {
  const test = unwrapExpression(condNode.test);
  let identName = null;
  if (test?.type === "Identifier") {
    identName = test.name;
  } else if (
    test?.type === "BinaryExpression" &&
    (test.operator === "!==" || test.operator === "!=") &&
    test.left?.type === "Identifier" &&
    isNullishNode(test.right)
  ) {
    identName = test.left.name;
  }
  if (!identName) return null;
  const cons = unwrapExpression(condNode.consequent);
  if (
    cons?.type === "MemberExpression" &&
    cons.object?.type === "Identifier" &&
    cons.object.name === identName
  ) {
    return identName;
  }
  return null;
}

function enclosingTernaryScope(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      cur.type === "BlockStatement" ||
      cur.type === "ObjectExpression" ||
      cur.type === "JSXElement" ||
      cur.type === "JSXFragment" ||
      isFunctionLike(cur) ||
      cur.type === "Program"
    ) {
      return cur;
    }
  }
  return null;
}

export const noRepeatedNullableTernariesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow testing the same nullable identifier across 3+ regular ternaries (`x ? x.a : ...`) in the same block or JSX/object expression.",
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
    const scopeCounts = new Map();
    return {
      ConditionalExpression(node) {
        if (
          node.parent?.type === "ConditionalExpression" ||
          node.consequent?.type === "ConditionalExpression" ||
          node.alternate?.type === "ConditionalExpression"
        ) {
          return;
        }
        const identName = testedNullableIdentifier(node);
        if (!identName) return;
        const container = enclosingTernaryScope(node);
        if (!container) return;
        let byIdent = scopeCounts.get(container);
        if (!byIdent) {
          byIdent = new Map();
          scopeCounts.set(container, byIdent);
        }
        const count = (byIdent.get(identName) ?? 0) + 1;
        byIdent.set(identName, count);
        if (count === 3) {
          context.report({
            node,
            message: `Nullable binding '${identName}' is tested across 3+ ternaries in the same scope; narrow '${identName}' once or use a resolved default object.`,
          });
        }
      },
    };
  },
};
