import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

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
          const variable = findVariable(context.sourceCode, specifier.local);
          const allInLayer =
            variable &&
            variable.references.length > 0 &&
            variable.references.every((ref) => {
              for (let cur = ref.identifier?.parent; cur; cur = cur.parent) {
                if (
                  cur.type === "CallExpression" &&
                  cur.callee?.type === "MemberExpression" &&
                  cur.callee.object?.type === "Identifier" &&
                  cur.callee.object.name === "Layer"
                ) {
                  return true;
                }
              }
              return false;
            });
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
        "Disallow function parameters that are only forwarded unchanged to another function.",
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
        "Parameter '{{name}}' is only forwarded unchanged to '{{callee}}'. Resolve it at the leaf or pass a narrower domain object.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;

    function checkFunction(node) {
      if (node.params.length < 4) return;
      for (const param of node.params) {
        if (param.type !== "Identifier") continue;
        const variable = findVariable(sourceCode, param);
        if (!variable || variable.references.length !== 1) continue;
        const ref = variable.references[0];
        const ident = ref.identifier;
        const call = ident?.parent;
        if (
          call?.type === "CallExpression" &&
          call.arguments.includes(ident) &&
          call.callee?.type === "Identifier"
        ) {
          const calleeVar = findVariable(sourceCode, call.callee);
          const calleeDef = calleeVar?.defs?.[0]?.node;
          if (
            calleeDef &&
            (isFunctionLike(calleeDef) || isFunctionLike(calleeDef.init))
          ) {
            context.report({
              node: param,
              messageId: "passThrough",
              data: { name: param.name, callee: call.callee.name },
            });
          }
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

    function checkFunction(node) {
      if (node.params.length === 0) return;
      if (node.params.some((p) => p.type !== "Identifier")) return;
      const name =
        node.id?.name ??
        (node.parent?.type === "VariableDeclarator" &&
        node.parent.id?.type === "Identifier"
          ? node.parent.id.name
          : null);
      if (!name) return;
      const isExported =
        node.parent?.type === "ExportNamedDeclaration" ||
        node.parent?.parent?.parent?.type === "ExportNamedDeclaration";
      if (isExported) return;
      const call = returnedCall(node.body);
      if (
        call?.type !== "CallExpression" ||
        call.callee?.type !== "Identifier" ||
        call.arguments.length !== node.params.length
      ) {
        return;
      }
      const sameOrder = node.params.every(
        (param, idx) =>
          call.arguments[idx]?.type === "Identifier" &&
          call.arguments[idx].name === param.name
      );
      if (!sameOrder) return;
      context.report({
        node: node.id ?? node,
        messageId: "wrapper",
        data: { name, callee: call.callee.name },
      });
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
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

    function hasValueReturn(body) {
      let found = false;
      function visit(cur) {
        if (found || !cur || typeof cur !== "object") return;
        if (isFunctionLike(cur)) return;
        if (cur.type === "ReturnStatement" && cur.argument !== null) {
          found = true;
          return;
        }
        for (const [k, v] of Object.entries(cur)) {
          if (k === "parent" || k === "range" || k === "loc") continue;
          if (Array.isArray(v)) {
            for (const item of v) visit(item);
          } else if (v && typeof v === "object") {
            visit(v);
          }
        }
      }
      visit(body);
      return found;
    }

    return {
      FunctionDeclaration(node) {
        if (node.body?.type !== "BlockStatement" || hasValueReturn(node.body)) {
          return;
        }
        for (const param of node.params) {
          if (param.type !== "Identifier" || EXEMPT_PARAM.test(param.name)) {
            continue;
          }
          const variable = findVariable(sourceCode, param);
          if (!variable) continue;
          const mutated = variable.references.find((ref) => {
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
              data: { name: param.name },
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

    function collectReferenceLiterals(ref, literals) {
      const parent = ref.identifier?.parent;
      if (
        parent?.type === "BinaryExpression" &&
        (parent.operator === "===" || parent.operator === "!==")
      ) {
        const other =
          parent.left === ref.identifier ? parent.right : parent.left;
        if (other?.type === "Literal" && typeof other.value === "string") {
          literals.add(`"${other.value}"`);
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
          }
        }
        return true;
      }
      return false;
    }

    function checkFunction(node) {
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
        const allComparisons = binding.references.every((ref) =>
          collectReferenceLiterals(ref, literals)
        );
        if (allComparisons && literals.size >= 2) {
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
