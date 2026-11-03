import {
  findVariable,
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

function hasLiteralEqualityTest(test) {
  if (!test) return false;
  if (test.type === "LogicalExpression") {
    return (
      hasLiteralEqualityTest(test.left) || hasLiteralEqualityTest(test.right)
    );
  }
  if (
    test.type === "BinaryExpression" &&
    (test.operator === "===" ||
      test.operator === "!==" ||
      test.operator === "==" ||
      test.operator === "!=")
  ) {
    return (
      test.left?.type === "Literal" ||
      test.right?.type === "Literal" ||
      test.left?.type === "TemplateLiteral" ||
      test.right?.type === "TemplateLiteral"
    );
  }
  return false;
}

function isHookCallee(callee) {
  if (callee?.type === "Identifier") {
    return /^use[A-Z0-9]/u.test(callee.name);
  }
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    /^use[A-Z0-9]/u.test(callee.property.name)
  );
}

function isConsumedByHookCall(identNode, sourceCode) {
  const binding = findVariable(sourceCode, identNode);
  if (!binding) return false;
  return binding.references.some((ref) => {
    if (ref.identifier === identNode) return false;
    for (
      let cur = ref.identifier.parent;
      cur && !isFunctionLike(cur);
      cur = cur.parent
    ) {
      if (cur.type === "CallExpression" && isHookCallee(cur.callee)) {
        return true;
      }
    }
    return false;
  });
}

function checkShreddedBindings(blockNode, context) {
  const byBase = new Map();
  for (const stmt of blockNode.body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) {
      if (
        decl.id?.type !== "Identifier" ||
        !decl.init ||
        isConsumedByHookCall(decl.id, context.sourceCode)
      ) {
        continue;
      }
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
}

function checkLiteralBranches(node, context) {
  if (node.parent?.type === "IfStatement" && node.parent.alternate === node) {
    return;
  }
  let branches = 1;
  let allLiteralTests = hasLiteralEqualityTest(node.test);
  let cur = node;
  while (cur.alternate) {
    branches += 1;
    if (cur.alternate.type === "IfStatement") {
      cur = cur.alternate;
      if (!hasLiteralEqualityTest(cur.test)) {
        allLiteralTests = false;
      }
    } else {
      break;
    }
  }
  if (branches >= 5 && allLiteralTests) {
    context.report({
      node,
      message: `Branch tree has ${branches} arms; declare a typed case table instead of chaining if/else branches.`,
    });
  }
}

export function createBranchChecks(context) {
  const scopeCounts = new Map();
  return {
    Program(node) {
      checkShreddedBindings(node, context);
    },
    BlockStatement(node) {
      checkShreddedBindings(node, context);
    },
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
    IfStatement(node) {
      checkLiteralBranches(node, context);
    },
  };
}
