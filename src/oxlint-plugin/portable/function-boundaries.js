import {
  checkParameterBags,
  recordProgramTypeDeclarations,
} from "./parameter-bag-checks.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

function returnedCall(body) {
  if (!body) return null;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1 || body.body[0].type !== "ReturnStatement") {
      return null;
    }
    return unwrapExpression(body.body[0].argument);
  }
  return unwrapExpression(body);
}

function unexportedFunctionName(node) {
  const parent = node.parent;
  if (
    parent?.type === "ExportNamedDeclaration" ||
    parent?.type === "ExportDefaultDeclaration" ||
    parent?.parent?.parent?.type === "ExportNamedDeclaration"
  ) {
    return null;
  }
  if (node.id?.name) return node.id.name;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  ) {
    return parent.id.name;
  }
  return null;
}

function hasValueReturn(body) {
  let found = false;
  function visit(cur) {
    if (found || !cur || typeof cur !== "object") return;
    if (isFunctionLike(cur)) return;
    if (cur.type === "ReturnStatement" && cur.argument !== null) {
      found = true;
      return;
    }
    for (const [k, child] of Object.entries(cur)) {
      if (k === "parent" || k === "range" || k === "loc") continue;
      if (Array.isArray(child)) {
        for (const element of child) visit(element);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  }
  visit(body);
  return found;
}

function conditionRootGroup(node) {
  let cur = node;
  while (
    cur.parent &&
    (cur.parent.type === "ParenthesizedExpression" ||
      (cur.parent.type === "LogicalExpression" && cur.parent.operator === "||"))
  ) {
    cur = cur.parent;
  }
  return cur;
}

function collectReferenceLiterals(ref, literals, groups) {
  const parent = ref.identifier?.parent;
  if (
    parent?.type === "BinaryExpression" &&
    (parent.operator === "===" || parent.operator === "!==")
  ) {
    const other = parent.left === ref.identifier ? parent.right : parent.left;
    if (other?.type === "Literal" && typeof other.value === "string") {
      literals.add(`"${other.value}"`);
      if (
        parent.operator === "!==" &&
        parent.parent?.type === "LogicalExpression" &&
        parent.parent.operator === "&&"
      ) {
        groups.add(parent);
      } else {
        groups.add(conditionRootGroup(parent));
      }
      return true;
    }
    return false;
  }
  if (
    parent?.type === "SwitchStatement" &&
    parent.discriminant === ref.identifier
  ) {
    for (const switchCase of parent.cases) {
      if (
        switchCase.test?.type === "Literal" &&
        typeof switchCase.test.value === "string"
      ) {
        literals.add(`"${switchCase.test.value}"`);
        groups.add(switchCase);
      }
    }
    return true;
  }
  return false;
}

function wrappingCandidate(node) {
  if (node.async || node.generator || node.params.length === 0) return;
  if (node.params.some((parameter) => parameter.type !== "Identifier")) return;
  const name = unexportedFunctionName(node);
  if (!name) return;
  const call = returnedCall(node.body);
  if (
    call?.type !== "CallExpression" ||
    call.callee?.type !== "Identifier" ||
    call.arguments.length !== node.params.length
  ) {
    return;
  }
  const sameOrder = node.params.every(
    (parameter, idx) =>
      call.arguments[idx]?.type === "Identifier" &&
      call.arguments[idx].name === parameter.name
  );
  if (!sameOrder) return;
  return {
    node: node.id ?? node,
    name,
    callee: call.callee.name,
  };
}

function isLayerReference(reference) {
  for (
    let current = reference.identifier?.parent;
    current;
    current = current.parent
  ) {
    if (
      current.type === "CallExpression" &&
      current.callee?.type === "MemberExpression" &&
      current.callee.object?.type === "Identifier" &&
      current.callee.object.name === "Layer"
    ) {
      return true;
    }
  }
  return false;
}

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export const noServiceConstructorImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-local make<CapabilityName> imports outside test and spec files.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const filename = (
      context.filename ??
      context.getFilename?.() ??
      ""
    ).replaceAll("\\", "/");
    if (TEST_FILE.test(filename)) return {};

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const source = node.source?.value;
        if (
          typeof source !== "string" ||
          (!source.startsWith("./") && !source.startsWith("../"))
        ) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type !== "ImportSpecifier" ||
            specifier.importKind === "type"
          ) {
            continue;
          }
          const importedName =
            specifier.imported?.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported?.value;
          if (
            typeof importedName !== "string" ||
            !SERVICE_CONSTRUCTOR_NAME.test(importedName)
          ) {
            continue;
          }
          const binding = findVariable(context.sourceCode, specifier.local);
          const allInLayer =
            binding &&
            binding.references.length > 0 &&
            binding.references.every(isLayerReference);
          if (allInLayer) continue;
          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName },
          });
        }
      },
    };
  },
};

function forwardedLocalCallee(sourceCode, parameter) {
  if (parameter.type !== "Identifier") return null;
  const binding = findVariable(sourceCode, parameter);
  if (!binding || binding.references.length !== 1) return null;
  const identifier = binding.references[0].identifier;
  const call = identifier?.parent;
  if (
    call?.type !== "CallExpression" ||
    !call.arguments.includes(identifier) ||
    call.callee?.type !== "Identifier"
  ) {
    return null;
  }
  const calleeVariable = findVariable(sourceCode, call.callee);
  const calleeDeclaration = calleeVariable?.defs?.[0]?.node;
  return calleeDeclaration &&
    (isFunctionLike(calleeDeclaration) ||
      isFunctionLike(calleeDeclaration.init))
    ? call.callee.name
    : null;
}

export const noPassThroughParametersRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow pass-through parameters, wide parameter bags (> 10 properties), and foreign state-callback bags.",
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
    messages: {
      passThrough:
        "Parameter '{{name}}' is only forwarded unchanged to '{{callee}}'. Resolve it at the leaf or pass a narrower domain object.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const typeDeclarations = new Map();

    function checkFunction(node) {
      if (node.params.length >= 4) {
        for (const parameter of node.params) {
          const callee = forwardedLocalCallee(sourceCode, parameter);
          if (callee) {
            context.report({
              node: parameter,
              messageId: "passThrough",
              data: { name: parameter.name, callee },
            });
          }
        }
      }

      checkParameterBags(node, typeDeclarations, context);
    }

    return {
      Program(node) {
        recordProgramTypeDeclarations(node, typeDeclarations);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

export const noWrappingFunctionsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow single-statement wrapper functions that only forward their parameters to a single call.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      wrapper:
        "Function '{{name}}' is a pass-through wrapper around '{{callee}}'. Call '{{callee}}' directly instead of adding a hop.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const exportedNames = new Set();
    const candidates = [];

    function checkFunction(node) {
      const candidate = wrappingCandidate(node);
      if (candidate) candidates.push(candidate);
    }

    return {
      ExportNamedDeclaration(node) {
        for (const spec of node.specifiers ?? []) {
          if (spec.local?.type === "Identifier") {
            exportedNames.add(spec.local.name);
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (node.declaration?.type === "Identifier") {
          exportedNames.add(node.declaration.name);
        }
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      "Program:exit"() {
        for (const cand of candidates) {
          if (exportedNames.has(cand.name)) continue;
          context.report({
            node: cand.node,
            messageId: "wrapper",
            data: { name: cand.name, callee: cand.callee },
          });
        }
      },
    };
  },
};

export const noArgumentMutationSideEffectRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions that mutate properties or elements of their arguments as a side effect instead of returning a value.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      mutatesArg:
        "Function mutates argument '{{name}}' in place instead of returning a result.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const EXEMPT_PARAM =
      /^(?:cache|ctx|context|memo|acc|accumulator|out|draft|state|req|res)$/i;

    return {
      FunctionDeclaration(node) {
        if (node.body?.type !== "BlockStatement" || hasValueReturn(node.body)) {
          return;
        }
        for (const parameter of node.params) {
          if (
            parameter.type !== "Identifier" ||
            EXEMPT_PARAM.test(parameter.name)
          ) {
            continue;
          }
          const binding = findVariable(sourceCode, parameter);
          if (!binding) continue;
          const mutated = binding.references.find((ref) => {
            const parent = ref.identifier?.parent;
            return (
              parent?.type === "MemberExpression" &&
              parent.object === ref.identifier &&
              parent.parent?.type === "AssignmentExpression" &&
              parent.parent.left === parent
            );
          });
          if (mutated) {
            context.report({
              node: mutated.identifier.parent.parent,
              messageId: "mutatesArg",
              data: { name: parameter.name },
            });
          }
        }
      },
    };
  },
};

export const noClosedStringParameterRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string parameters whose body immediately restricts them to a closed literal union.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      closedString:
        "Parameter '{{name}}' is typed as `string` but restricted to closed literals ({{literals}}). Type the parameter as a literal union instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;

    const BOUNDARY_DECODER_NAME = /^(?:decode|parse|normalize)[A-Z]/u;

    function checkFunction(node) {
      if (node.id?.name && BOUNDARY_DECODER_NAME.test(node.id.name)) return;
      for (const parameter of node.params) {
        if (
          parameter.type !== "Identifier" ||
          parameter.typeAnnotation?.typeAnnotation?.type !== "TSStringKeyword"
        ) {
          continue;
        }
        const binding = findVariable(sourceCode, parameter);
        if (!binding || binding.references.length < 2) continue;
        const literals = new Set();
        const groups = new Set();
        const allComparisons = binding.references.every((ref) =>
          collectReferenceLiterals(ref, literals, groups)
        );
        if (allComparisons && literals.size >= 2 && groups.size >= 2) {
          context.report({
            node: parameter,
            messageId: "closedString",
            data: {
              name: parameter.name,
              literals: [...literals].join(" | "),
            },
          });
        }
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};
