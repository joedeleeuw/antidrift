import {
  argumentMutations,
  booleanModeParameter,
  closedCollectionGuard,
  functionBinding,
  outcomeTranslation,
  wrapperCandidate,
} from "./function-boundary-helpers.js";
import { passThroughVisitors } from "./parameter-bag-checks.js";
import { getProgramIndex } from "../shared/program-index.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable, staticPropertyName } from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

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
    schema: SCOPE_SCHEMA,
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const filename = (context.filename ?? "").replaceAll("\\", "/");
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

export const noPassThroughParametersRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow pass-through parameters, member-extraction forwarding, wide parameter bags (> 10 properties), foreign state-callback bags, and call-site mutator closures.",
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
      memberExtraction:
        "Parameter '{{name}}' is only unpacked into '{{callee}}' ({{members}}); pass '{{name}}' itself or let '{{callee}}' accept the owning object.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return passThroughVisitors(context);
  },
};

function reportWrapperCandidate(context, cand, fileFacts) {
  const exported = cand.exported || fileFacts.exportedNames.has(cand.name);
  const hop = { name: cand.name, callee: cand.callee };
  if (!exported) {
    context.report({ node: cand.node, messageId: "wrapper", data: hop });
    return;
  }
  const programIndex = getProgramIndex(context.sourceCode);
  const calls =
    (programIndex?.callStats.get(cand.name)?.totalCalls ?? 0) -
    (fileFacts.memberCalls.get(cand.name) ?? 0);
  if (programIndex && calls <= 1) {
    context.report({ node: cand.node, messageId: "unusedHop", data: hop });
  }
}

function wrappingVisitors(context) {
  const sourceCode = context.sourceCode;
  const exportedNames = new Set();
  const memberCalls = new Map();
  const candidates = [];
  function checkFunction(node) {
    const candidate = wrapperCandidate(node, sourceCode);
    if (candidate) candidates.push(candidate);
    const translation = outcomeTranslation(node, sourceCode);
    if (translation) {
      context.report({
        node: node.id ?? node,
        messageId: "outcomeTranslation",
        data: translation,
      });
    }
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
    CallExpression(node) {
      const name = staticPropertyName(node.callee);
      if (name) memberCalls.set(name, (memberCalls.get(name) ?? 0) + 1);
    },
    "Program:exit"() {
      for (const cand of candidates) {
        reportWrapperCandidate(context, cand, { exportedNames, memberCalls });
      }
    },
  };
}

export const noWrappingFunctionsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow single-statement wrapper functions that only forward their parameters to a single call, and single-call outcome-translation wrappers.",
    },
    schema: SCOPE_SCHEMA,
    messages: {
      wrapper:
        "Function '{{name}}' is a pass-through wrapper around '{{callee}}'. Call '{{callee}}' directly instead of adding a hop.",
      unusedHop:
        "Exported '{{name}}' is a hop to '{{callee}}' with at most one call site in the program; call '{{callee}}' directly and delete '{{name}}'.",
      outcomeTranslation:
        "Function '{{name}}' only translates the outcome of '{{callee}}' through {{count}} discriminant branches; return the owner's result or move the mapping into '{{callee}}'.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return wrappingVisitors(context);
  },
};

export const noArgumentMutationSideEffectRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions that mutate properties or elements of their arguments as a side effect instead of returning a value.",
    },
    schema: SCOPE_SCHEMA,
    messages: {
      mutatesArg:
        "Function mutates argument '{{name}}' in place instead of returning a result.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    function check(node) {
      if (
        node.type !== "FunctionDeclaration" &&
        !functionBinding(node)?.exported
      ) {
        return;
      }
      for (const mutation of argumentMutations(node, context.sourceCode)) {
        context.report({
          node: mutation.node,
          messageId: "mutatesArg",
          data: { name: mutation.name },
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
    if (other?.type !== "Literal" || typeof other.value !== "string") {
      return false;
    }
    literals.add(`"${other.value}"`);
    const pairedNegation =
      parent.operator === "!==" &&
      parent.parent?.type === "LogicalExpression" &&
      parent.parent.operator === "&&";
    groups.add(pairedNegation ? parent : conditionRootGroup(parent));
    return true;
  }
  if (
    parent?.type !== "SwitchStatement" ||
    parent.discriminant !== ref.identifier
  ) {
    return false;
  }
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

const BOUNDARY_DECODER_NAME =
  /^(?:decode|parse|normalize|assert|validate|ensure|coerce)[A-Z]/u;

function closedLiterals(binding, sourceCode) {
  const literals = new Set();
  const groups = new Set();
  const allComparisons = binding.references.every((ref) =>
    collectReferenceLiterals(ref, literals, groups)
  );
  if (allComparisons && literals.size >= 2 && groups.size >= 2) {
    return [...literals];
  }
  return closedCollectionGuard(binding, sourceCode);
}

function checkClosedParameters(node, context) {
  const sourceCode = context.sourceCode;
  const name = functionBinding(node)?.name ?? "";
  if (
    BOUNDARY_DECODER_NAME.test(name) ||
    node.returnType?.typeAnnotation?.type === "TSTypePredicate"
  ) {
    return;
  }
  for (const parameter of node.params) {
    const binding =
      parameter.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword"
        ? findVariable(sourceCode, parameter)
        : null;
    const literals =
      binding && binding.references.length >= 2
        ? closedLiterals(binding, sourceCode)
        : null;
    if (literals) {
      context.report({
        node: parameter,
        messageId: "closedString",
        data: { name: parameter.name, literals: literals.join(" | ") },
      });
    }
  }
  const booleanMode = booleanModeParameter(node, sourceCode);
  if (booleanMode) {
    context.report({
      node: booleanMode.parameter,
      messageId: "booleanFlagModeParameter",
      data: {
        name: booleanMode.parameter.name,
        functionName: booleanMode.functionName,
      },
    });
  }
}

export const noClosedStringParameterRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string parameters whose body immediately restricts them to a closed literal union, and exported positional boolean mode flags.",
    },
    schema: SCOPE_SCHEMA,
    messages: {
      closedString:
        "Parameter '{{name}}' is typed as `string` but restricted to closed literals ({{literals}}). Type the parameter as a literal union instead.",
      booleanFlagModeParameter:
        "'{{functionName}}' takes a positional boolean '{{name}}' that only selects between two branches; split '{{functionName}}' into one function per mode or take a named mode union.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const check = (node) => checkClosedParameters(node, context);
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
};
