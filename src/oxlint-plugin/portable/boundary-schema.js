import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const SCHEMA_DECODE_METHODS = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "decodeUnknownSync",
  "decodeUnknownEither",
  "decodeUnknownPromise",
  "decodeSync",
]);

function isRawDeserializeCall(node) {
  const expr = unwrapExpression(node);
  if (expr?.type === "AwaitExpression") {
    return isRawDeserializeCall(expr.argument);
  }
  if (expr?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expr.callee);
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier"
  ) {
    const prop = callee.property.name;
    if (
      callee.object?.type === "Identifier" &&
      (callee.object.name === "JSON" || callee.object.name === "YAML") &&
      prop === "parse"
    ) {
      return true;
    }
    if (
      prop === "json" &&
      callee.object?.type === "Identifier" &&
      /^(?:res|response|req|request)$/iu.test(callee.object.name)
    ) {
      return true;
    }
  }
  return false;
}

function isPassedToDecoder(node) {
  const parent = node.parent;
  if (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
    const callee = unwrapExpression(parent.callee);
    if (
      callee?.type === "MemberExpression" &&
      callee.property?.type === "Identifier" &&
      SCHEMA_DECODE_METHODS.has(callee.property.name)
    ) {
      return true;
    }
    if (callee?.type === "Identifier") return true;
  }
  return false;
}

export const noUnsafeDeserializeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting raw JSON.parse / response.json() results directly to a domain type without schema decoding.",
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
      TSAsExpression(node) {
        if (!isRawDeserializeCall(node.expression)) return;
        const target = node.typeAnnotation;
        if (target?.type === "TSUnknownKeyword") return;
        context.report({
          node,
          message:
            "Do not cast raw deserialized JSON directly to a domain type; decode once at the boundary with a schema validator.",
        });
      },
      VariableDeclarator(node) {
        if (!node.init || !isRawDeserializeCall(node.init)) return;
        const ann = node.id?.typeAnnotation?.typeAnnotation;
        if (!ann || ann.type === "TSUnknownKeyword") return;
        if (isPassedToDecoder(node.init)) return;
        context.report({
          node,
          message:
            "Do not assign raw deserialized JSON directly to an explicitly typed binding; decode with a schema validator first.",
        });
      },
    };
  },
};

export const unknownInputMustBeDecodedRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting or probing `: unknown` boundary parameters into domain types without a schema decoder.",
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

    function isPredicateFunction(fnNode) {
      return fnNode.returnType?.typeAnnotation?.type === "TSTypePredicate";
    }

    function checkFunction(node) {
      if (isPredicateFunction(node)) return;
      for (const param of node.params) {
        if (
          param.type !== "Identifier" ||
          param.typeAnnotation?.typeAnnotation?.type !== "TSUnknownKeyword"
        ) {
          continue;
        }
        const variable = findVariable(sourceCode, param);
        if (!variable) continue;
        let inCheckCount = 0;
        for (const ref of variable.references) {
          const parent = ref.identifier?.parent;
          if (
            parent?.type === "TSAsExpression" &&
            parent.typeAnnotation?.type !== "TSUnknownKeyword"
          ) {
            context.report({
              node: parent,
              message: `Unknown input '${param.name}' is cast directly instead of decoded through a boundary schema.`,
            });
          }
          if (
            parent?.type === "BinaryExpression" &&
            parent.operator === "in" &&
            parent.right === ref.identifier
          ) {
            inCheckCount += 1;
          }
        }
        if (inCheckCount >= 4) {
          context.report({
            node: param,
            message: `Unknown input '${param.name}' is probed with ${inCheckCount} ad-hoc 'in' checks; decode once with a boundary schema instead.`,
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

export const noRedundantZodParseRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow re-parsing a value with the same schema after `.parse()` / `.parseAsync()` or when already typed as `z.infer<typeof Schema>`.",
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

    function parseCallInfo(node) {
      let expr = unwrapExpression(node);
      if (expr?.type === "AwaitExpression") {
        expr = unwrapExpression(expr.argument);
      }
      if (expr?.type !== "CallExpression" || expr.arguments.length !== 1) {
        return null;
      }
      const callee = unwrapExpression(expr.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed ||
        callee.property?.type !== "Identifier"
      ) {
        return null;
      }
      const method = callee.property.name;
      if (
        method !== "parse" &&
        method !== "safeParse" &&
        method !== "parseAsync" &&
        method !== "safeParseAsync"
      ) {
        return null;
      }
      return {
        method,
        returnsDecodedValue: method === "parse" || method === "parseAsync",
        schemaText: sourceCode.getText(callee.object).replace(/\s+/gu, ""),
      };
    }

    function matchesInferredParameterSchema(def, schemaText) {
      if (def.type !== "Parameter") return false;
      const ann = def.name?.typeAnnotation?.typeAnnotation;
      if (
        ann?.type !== "TSTypeReference" ||
        ann.typeName?.type !== "TSQualifiedName"
      ) {
        return false;
      }
      const rightName = ann.typeName.right?.name;
      if (rightName !== "infer" && rightName !== "output") return false;
      const typeArg = ann.typeArguments?.params?.[0];
      if (typeArg?.type !== "TSTypeQuery" || !typeArg.exprName) return false;
      return (
        sourceCode.getText(typeArg.exprName).replace(/\s+/gu, "") === schemaText
      );
    }

    return {
      CallExpression(node) {
        const outer = parseCallInfo(node);
        if (!outer) return;
        const arg = unwrapExpression(node.arguments[0]);
        const inner = parseCallInfo(arg);
        if (
          inner?.returnsDecodedValue &&
          inner.schemaText === outer.schemaText
        ) {
          context.report({
            node,
            message:
              "Redundant schema parse on an already-parsed expression; decode once at the boundary and reuse the typed value.",
          });
          return;
        }
        if (arg?.type !== "Identifier") return;
        const def = findVariable(sourceCode, arg)?.defs?.[0];
        if (!def) return;
        if (def.node?.type === "VariableDeclarator") {
          const initInfo = parseCallInfo(def.node.init);
          if (
            initInfo?.returnsDecodedValue &&
            initInfo.schemaText === outer.schemaText
          ) {
            context.report({
              node,
              message: `Binding '${arg.name}' was already decoded by '${outer.schemaText}' in this scope; reuse the decoded value instead of re-parsing.`,
            });
            return;
          }
        }
        if (matchesInferredParameterSchema(def, outer.schemaText)) {
          context.report({
            node,
            message: `Parameter '${arg.name}' is already typed as a decoded schema output; do not re-parse internal typed values.`,
          });
        }
      },
    };
  },
};

export const noIdentitySchemaTransformRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `.transform(x => x)` or exhaustive destructuring `.transform(({ a, b }) => ({ a, b }))` no-ops on schemas.",
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
    function isIdentityTransform(param, body) {
      const expr = unwrapExpression(body);
      if (!expr) return false;
      if (param.type === "Identifier") {
        return expr.type === "Identifier" && expr.name === param.name;
      }
      if (
        param.type === "ObjectPattern" &&
        param.properties.length > 0 &&
        expr.type === "ObjectExpression" &&
        expr.properties.length === param.properties.length
      ) {
        const bindings = new Map();
        for (const prop of param.properties) {
          if (
            prop.type !== "Property" ||
            prop.computed ||
            prop.key?.type !== "Identifier" ||
            prop.value?.type !== "Identifier"
          ) {
            return false;
          }
          bindings.set(prop.key.name, prop.value.name);
        }
        return expr.properties.every(
          (p) =>
            p.type === "Property" &&
            !p.computed &&
            p.key?.type === "Identifier" &&
            p.value?.type === "Identifier" &&
            bindings.get(p.key.name) === p.value.name
        );
      }
      return false;
    }
    return {
      CallExpression(node) {
        if (
          node.callee?.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property?.type !== "Identifier" ||
          node.callee.property.name !== "transform"
        ) {
          return;
        }
        const cb = unwrapExpression(node.arguments[0]);
        if (!isFunctionLike(cb) || cb.async || cb.params.length !== 1) return;
        const param = cb.params[0];
        const returned =
          cb.body?.type === "BlockStatement" &&
          cb.body.body.length === 1 &&
          cb.body.body[0].type === "ReturnStatement"
            ? cb.body.body[0].argument
            : cb.body;
        if (isIdentityTransform(param, returned)) {
          context.report({
            node,
            message:
              "Schema `.transform()` performs an identity pass-through; remove the no-op transform.",
          });
        }
      },
    };
  },
};

export const noSchemaValidatorTranscodingRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow transcoding a runtime schema through `toJSONSchema` / `zodToJsonSchema` into another runtime validator.",
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
    function isJsonSchemaCall(node) {
      const expr = unwrapExpression(node);
      if (expr?.type !== "CallExpression") return false;
      const callee = unwrapExpression(expr.callee);
      if (callee?.type === "Identifier") {
        return (
          callee.name === "zodToJsonSchema" || callee.name === "toJSONSchema"
        );
      }
      return (
        callee?.type === "MemberExpression" &&
        callee.property?.type === "Identifier" &&
        callee.property.name === "toJSONSchema"
      );
    }
    function isLocalFunctionCall(node) {
      const callee = unwrapExpression(node.callee);
      if (callee?.type !== "Identifier") return false;
      const v = findVariable(context.sourceCode, callee);
      const def = v?.defs?.[0];
      return (
        def?.type === "FunctionName" ||
        (def?.type === "Variable" && isFunctionLike(def.node?.init))
      );
    }
    return {
      CallExpression(node) {
        if (isLocalFunctionCall(node)) return;
        if (node.arguments.some(isJsonSchemaCall)) {
          context.report({
            node,
            message:
              "Do not transcode a schema through JSON Schema into another validator; share one canonical schema definition.",
          });
        }
      },
    };
  },
};
