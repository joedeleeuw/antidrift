import { isRuleFile, scopeProperties } from "../../oxlint-plugin/portable/scope.js";

const CALL_TYPES = new Set(["CallExpression", "NewExpression"]);
const TYPE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);
const NAMED_FUNCTION_PARENTS = new Set([
  "ExportDefaultDeclaration",
  "MethodDefinition",
  "PropertyDefinition",
  "VariableDeclarator",
]);
const FIRST_PARTY_SPECIFIER = /^(?:\.{1,2}\/|[@~#]\/)/;

function outerExpression(node) {
  let current = node;
  while (TYPE_WRAPPERS.has(current.parent?.type)) current = current.parent;
  return current;
}

function isCallArgument(node) {
  return (
    CALL_TYPES.has(node.parent?.type) && node.parent.arguments.includes(node)
  );
}

function isInlineOptionsLiteral(object) {
  let current = outerExpression(object);
  while (
    current.parent.type === "Property" &&
    current.parent.parent.type === "ObjectExpression"
  ) {
    current = outerExpression(current.parent.parent);
  }
  return (
    isCallArgument(current) || current.parent.type === "JSXExpressionContainer"
  );
}

function isNamedFunction(node) {
  return (
    node.type === "FunctionDeclaration" ||
    NAMED_FUNCTION_PARENTS.has(node.parent.type) ||
    (node.parent.type === "Property" &&
      node.parent.value === node &&
      !isInlineOptionsLiteral(node.parent.parent))
  );
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

function rootName(node) {
  let current = node;
  while (
    current.type === "MemberExpression" ||
    current.type === "JSXMemberExpression"
  ) {
    current = current.object;
  }
  return current;
}

const FUNCTION_VALUES = new Set([
  "ArrowFunctionExpression",
  "ClassExpression",
  "FunctionExpression",
]);

function definesFunction(node) {
  return (
    FUNCTION_VALUES.has(node?.type) ||
    (node?.type === "CallExpression" &&
      FUNCTION_VALUES.has(node.arguments[0]?.type))
  );
}

function isFirstPartyLayer(callee, sourceCode) {
  const root = rootName(callee);
  if (root.type === "ThisExpression") return callee.object === root;
  if (root.type !== "Identifier" && root.type !== "JSXIdentifier") {
    return false;
  }
  if (root.type === "JSXIdentifier" && !/^[A-Z]/.test(root.name)) return false;
  const definition = findVariable(sourceCode.getScope(callee), root.name)
    ?.defs[0];
  if (definition?.type === "ImportBinding") {
    return (
      FIRST_PARTY_SPECIFIER.test(definition.parent.source.value) &&
      (callee === root ||
        definition.node.type === "ImportNamespaceSpecifier")
    );
  }
  if (callee !== root) return false;
  return (
    definition?.type === "FunctionName" ||
    definition?.type === "ClassName" ||
    (definition?.type === "Variable" && definesFunction(definition.node.init))
  );
}

function isDelegatedResult(call) {
  let node = outerExpression(call);
  while (
    node.parent.type === "AwaitExpression" ||
    node.parent.type === "ChainExpression"
  ) {
    node = outerExpression(node.parent);
  }
  const { parent } = node;
  return (
    parent.type === "ExpressionStatement" ||
    parent.type === "ReturnStatement" ||
    (parent.type === "ArrowFunctionExpression" && parent.body === node)
  );
}

function forwardingCall(node) {
  const { parent } = node;
  if (isCallArgument(node)) return parent;
  if (parent.type === "SpreadElement") {
    if (isCallArgument(parent)) return parent.parent;
    if (
      parent.parent.type === "ObjectExpression" &&
      isCallArgument(parent.parent)
    ) {
      return parent.parent.parent;
    }
    return null;
  }
  if (
    parent.type === "Property" &&
    parent.shorthand &&
    parent.value === node &&
    isCallArgument(parent.parent)
  ) {
    return parent.parent.parent;
  }
  return null;
}

function forwardingElement(node) {
  const { parent } = node;
  if (
    parent.type === "JSXExpressionContainer" &&
    parent.parent.type === "JSXAttribute"
  ) {
    return parent.parent.parent;
  }
  return parent.type === "JSXSpreadAttribute" ? parent.parent : null;
}

function forwardTarget(identifier, sourceCode) {
  const node = outerExpression(identifier);
  const call = forwardingCall(node);
  if (call) {
    return isDelegatedResult(call) &&
      isFirstPartyLayer(call.callee, sourceCode)
      ? sourceCode.getText(call.callee)
      : null;
  }
  const element = forwardingElement(node);
  return element && isFirstPartyLayer(element.name, sourceCode)
    ? sourceCode.getText(element.name)
    : null;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow parameters and destructured props that a named function or component only forwards to another first-party layer and never reads itself.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      passThrough:
        "'{{name}}' is a pass-through variable: this function never reads it and only forwards it to {{targets}}. Let that layer obtain it from its owner, or move the work that needs it here.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const { sourceCode } = context;

    function check(node) {
      if (!node.body || !isNamedFunction(node)) return;
      for (const variable of sourceCode.getDeclaredVariables(node)) {
        const definition = variable.defs[0];
        if (definition?.type !== "Parameter" || definition.node !== node) {
          continue;
        }
        const references = variable.references.filter(
          (reference) =>
            !reference.isTypeReference &&
            reference.identifier !== definition.name,
        );
        if (
          references.length === 0 ||
          references.some((reference) => reference.isWrite())
        ) {
          continue;
        }
        const targets = references.map((reference) =>
          forwardTarget(reference.identifier, sourceCode),
        );
        if (targets.includes(null)) continue;
        context.report({
          node: definition.name,
          messageId: "passThrough",
          data: {
            name: variable.name,
            targets: [...new Set(targets)]
              .map((target) => `'${target}'`)
              .join(", "),
          },
        });
      }
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
};
