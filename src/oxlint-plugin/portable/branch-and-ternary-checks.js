import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";
import { resolvedDeclarationFiles } from "../shared/type-services.js";

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

function memberAndLiteralSides(test) {
  if (test.left?.type === "MemberExpression") {
    return { member: test.left, literal: test.right };
  }
  if (test.right?.type === "MemberExpression") {
    return { member: test.right, literal: test.left };
  }
  return { member: null, literal: null };
}

function extractDiscriminantComparison(testNode) {
  const test = unwrapExpression(testNode);
  if (
    test?.type !== "BinaryExpression" ||
    (test.operator !== "===" && test.operator !== "!==")
  ) {
    return null;
  }
  const { member, literal } = memberAndLiteralSides(test);
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
    operator: test.operator,
  };
}

function extractDiscriminantShred(initNode) {
  const expr = unwrapExpression(initNode);
  if (expr?.type !== "ConditionalExpression") return null;
  if (!isNullishNode(expr.alternate) && !isNullishNode(expr.consequent)) {
    return null;
  }
  return extractDiscriminantComparison(expr.test);
}

function subtreeReferencesName(rootNode, targetName) {
  if (!rootNode || typeof rootNode !== "object") return false;
  if (rootNode.type === "Identifier" && rootNode.name === targetName) {
    return true;
  }
  for (const [key, child] of Object.entries(rootNode)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    if (Array.isArray(child)) {
      if (child.some((element) => subtreeReferencesName(element, targetName))) {
        return true;
      }
    } else if (
      child &&
      typeof child.type === "string" &&
      subtreeReferencesName(child, targetName)
    ) {
      return true;
    }
  }
  return false;
}

function testedNullableIdentifier(condNode, container) {
  const test = unwrapExpression(condNode.test);
  let identNode = null;
  if (test?.type === "Identifier") {
    identNode = test;
  } else if (
    test?.type === "BinaryExpression" &&
    (test.operator === "!==" || test.operator === "!=") &&
    test.left?.type === "Identifier" &&
    isNullishNode(test.right)
  ) {
    identNode = test.left;
  }
  if (!identNode) return null;
  if (subtreeReferencesName(condNode.consequent, identNode.name)) {
    return { name: identNode.name, referencesConsequent: true };
  }
  if (
    isNullishNode(condNode.alternate) &&
    (container?.type === "JSXElement" ||
      container?.type === "JSXFragment" ||
      container?.type === "ObjectExpression")
  ) {
    return { name: identNode.name, referencesConsequent: false };
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

function countDiscriminantTestsInScope(rootNode, counts = new Map()) {
  if (!rootNode || typeof rootNode !== "object") return counts;
  const cmp = extractDiscriminantComparison(rootNode);
  if (cmp) {
    const key = `${cmp.baseName}.${cmp.discKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [field, child] of Object.entries(rootNode)) {
    if (field === "parent" || field === "range" || field === "loc") continue;
    if (Array.isArray(child)) {
      for (const element of child) {
        if (element && !isFunctionLike(element)) {
          countDiscriminantTestsInScope(element, counts);
        }
      }
    } else if (
      child &&
      typeof child.type === "string" &&
      !isFunctionLike(child)
    ) {
      countDiscriminantTestsInScope(child, counts);
    }
  }
  return counts;
}

function checkShreddedBindings(blockNode, context) {
  const discCounts = countDiscriminantTestsInScope(blockNode);
  const byBase = new Map();
  const reportedKeys = new Set();
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
      const totalTests = discCounts.get(key) ?? 0;
      if (
        !reportedKeys.has(key) &&
        (entry.literals.size >= 2 ||
          (entry.literals.size === 1 && totalTests >= 3))
      ) {
        reportedKeys.add(key);
        context.report({
          node: decl,
          message: `Discriminated union '${shred.baseName}' is shredded into parallel nullable bindings; narrow '${shred.baseName}' once via switch or a case table instead.`,
        });
      }
    }
  }
}

function checkNegatedDiscriminantScatter(blockNode, context) {
  const negatedByKey = new Map();
  const positiveKeys = new Set();
  for (const stmt of blockNode.body) {
    if (stmt.type !== "IfStatement") continue;
    const cmp = extractDiscriminantComparison(stmt.test);
    if (!cmp) continue;
    const key = `${cmp.baseName}.${cmp.discKey}`;
    if (cmp.operator === "===") {
      positiveKeys.add(key);
    } else if (cmp.operator === "!==") {
      const list = negatedByKey.get(key) ?? [];
      list.push(stmt);
      negatedByKey.set(key, list);
    }
  }
  for (const [key, stmts] of negatedByKey) {
    if ((stmts.length >= 2 && positiveKeys.has(key)) || stmts.length >= 3) {
      context.report({
        node: stmts[1],
        message: `Scattered negated discriminant checks on '${key}'; handle all variants in a single switch or case table.`,
      });
    }
  }
}

function isRepoOwnedSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    (specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("@/") ||
      specifier.startsWith("~/") ||
      specifier.startsWith("#/"))
  );
}

function isImportDefRepoOwned(def) {
  return (
    def?.type === "ImportBinding" &&
    def.parent?.type === "ImportDeclaration" &&
    isRepoOwnedSpecifier(def.parent.source?.value)
  );
}

function isAnnotationRepoOwned(annotation, localTypes, sourceCode) {
  if (annotation?.type === "TSTypeLiteral") return true;
  if (
    annotation?.type !== "TSTypeReference" ||
    annotation.typeName?.type !== "Identifier"
  ) {
    return false;
  }
  if (localTypes.has(annotation.typeName.name)) return true;
  const typeDef = findVariable(sourceCode, annotation.typeName)?.defs?.[0];
  return isImportDefRepoOwned(typeDef);
}

function isProvenRepoOwnedReceiver(identNode, localTypes, context) {
  const sourceCode = context.sourceCode;
  const declFiles = resolvedDeclarationFiles(identNode, sourceCode);
  if (declFiles.length > 0) {
    return declFiles.every((file) => !file.includes("/node_modules/"));
  }
  const def = findVariable(sourceCode, identNode)?.defs?.[0];
  if (!def) return false;
  if (isImportDefRepoOwned(def)) return true;
  const annotation = def.name?.typeAnnotation?.typeAnnotation;
  if (isAnnotationRepoOwned(annotation, localTypes, sourceCode)) return true;
  const init = unwrapExpression(def.node?.init);
  if (init?.type === "ObjectExpression") return true;
  if (init?.type === "CallExpression" && init.callee?.type === "Identifier") {
    const calleeDef = findVariable(sourceCode, init.callee)?.defs?.[0];
    return (
      calleeDef?.type === "FunctionName" || isImportDefRepoOwned(calleeDef)
    );
  }
  return false;
}

function checkNestedExistenceTernary(node, localTypes, context) {
  if (
    node.parent?.type === "ConditionalExpression" ||
    node.alternate?.type !== "ConditionalExpression"
  ) {
    return;
  }
  const firstTest = unwrapExpression(node.test);
  const secondTest = unwrapExpression(node.alternate.test);
  if (
    firstTest?.type !== "MemberExpression" ||
    secondTest?.type !== "MemberExpression" ||
    firstTest.computed ||
    secondTest.computed ||
    firstTest.object?.type !== "Identifier" ||
    secondTest.object?.type !== "Identifier" ||
    firstTest.object.name !== secondTest.object.name ||
    firstTest.property?.name === secondTest.property?.name
  ) {
    return;
  }
  if (!isProvenRepoOwnedReceiver(firstTest.object, localTypes, context)) {
    return;
  }
  context.report({
    node,
    message: `Nested existence ternaries probe multiple properties on '${firstTest.object.name}'; model '${firstTest.object.name}' as a discriminated union instead.`,
  });
}

function checkRepeatedNullableTernary(node, scopeCounts, context) {
  if (
    node.parent?.type === "ConditionalExpression" ||
    node.consequent?.type === "ConditionalExpression" ||
    node.alternate?.type === "ConditionalExpression"
  ) {
    return;
  }
  const container = enclosingTernaryScope(node);
  if (!container) return;
  const tested = testedNullableIdentifier(node, container);
  if (!tested) return;
  let byIdent = scopeCounts.get(container);
  if (!byIdent) {
    byIdent = new Map();
    scopeCounts.set(container, byIdent);
  }
  const state = byIdent.get(tested.name) ?? {
    count: 0,
    hasConsequentRef: false,
    reported: false,
  };
  state.count += 1;
  if (tested.referencesConsequent) state.hasConsequentRef = true;
  byIdent.set(tested.name, state);
  const isCompactContainer =
    container.type === "ObjectExpression" ||
    container.type === "JSXElement" ||
    container.type === "JSXFragment";
  const threshold = isCompactContainer ? 2 : 3;
  if (!state.reported && state.hasConsequentRef && state.count >= threshold) {
    state.reported = true;
    context.report({
      node,
      message: `Nullable binding '${tested.name}' is tested across 3+ ternaries in the same scope; narrow '${tested.name}' once or use a resolved default object.`,
    });
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

function normalizeSwitchCaseSkeleton(switchCase, sourceCode) {
  const stmts = (switchCase.consequent ?? []).filter(
    (stmt) => stmt.type !== "BreakStatement"
  );
  const bodyStmts =
    stmts.length === 1 && stmts[0].type === "BlockStatement"
      ? stmts[0].body.filter((stmt) => stmt.type !== "BreakStatement")
      : stmts;
  if (bodyStmts.length < 2) return null;
  return bodyStmts
    .map((stmt) =>
      sourceCode
        .getText(stmt)
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+\b/gu, "$LIT")
        .replace(/\s+/gu, " ")
        .trim()
    )
    .join(";");
}

function checkSwitchStatement(node, context) {
  const cases = (node.cases ?? []).filter((arm) => arm.test !== null);
  if (cases.length < 3) return;
  const counts = new Map();
  for (const arm of cases) {
    const skeleton = normalizeSwitchCaseSkeleton(arm, context.sourceCode);
    if (!skeleton) continue;
    const count = (counts.get(skeleton) ?? 0) + 1;
    counts.set(skeleton, count);
    if (count === 3) {
      context.report({
        node,
        message:
          "Switch cases repeat the same multi-statement skeleton with different literals; extract a data table or helper.",
      });
      return;
    }
  }
}

export function createBranchChecks(context) {
  const scopeCounts = new Map();
  const localTypes = new Set();
  return {
    TSInterfaceDeclaration(node) {
      if (node.id?.name) localTypes.add(node.id.name);
    },
    TSTypeAliasDeclaration(node) {
      if (node.id?.name) localTypes.add(node.id.name);
    },
    Program(node) {
      checkShreddedBindings(node, context);
      checkNegatedDiscriminantScatter(node, context);
    },
    BlockStatement(node) {
      checkShreddedBindings(node, context);
      checkNegatedDiscriminantScatter(node, context);
    },
    ConditionalExpression(node) {
      checkNestedExistenceTernary(node, localTypes, context);
      checkRepeatedNullableTernary(node, scopeCounts, context);
    },
    IfStatement(node) {
      checkLiteralBranches(node, context);
    },
    SwitchStatement(node) {
      checkSwitchStatement(node, context);
    },
  };
}
