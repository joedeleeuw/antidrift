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
        "Disallow re-parsing a value that was already decoded by a schema or typed as `z.infer<typeof Schema>`.",
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

    function isSchemaParseCall(node) {
      const expr = unwrapExpression(node);
      if (expr?.type !== "CallExpression" || expr.arguments.length !== 1) {
        return false;
      }
      const callee = unwrapExpression(expr.callee);
      return (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.property?.type === "Identifier" &&
        (callee.property.name === "parse" ||
          callee.property.name === "safeParse" ||
          callee.property.name === "parseAsync")
      );
    }

    return {
      CallExpression(node) {
        if (!isSchemaParseCall(node)) return;
        const arg = unwrapExpression(node.arguments[0]);
        if (isSchemaParseCall(arg)) {
          context.report({
            node,
            message:
              "Redundant schema parse on an already-parsed expression; decode once at the boundary and reuse the typed value.",
          });
          return;
        }
        if (arg?.type !== "Identifier") return;
        const variable = findVariable(sourceCode, arg);
        const def = variable?.defs?.[0];
        if (!def) return;
        if (
          def.node?.type === "VariableDeclarator" &&
          isSchemaParseCall(def.node.init)
        ) {
          context.report({
            node,
            message: `Binding '${arg.name}' was already decoded by a schema in this scope; reuse the decoded value instead of re-parsing.`,
          });
          return;
        }
        if (def.type === "Parameter") {
          const param = def.name;
          const ann = param?.typeAnnotation?.typeAnnotation;
          if (
            ann?.type === "TSTypeReference" &&
            ann.typeName?.type === "TSQualifiedName" &&
            ann.typeName.right?.name === "infer"
          ) {
            context.report({
              node,
              message: `Parameter '${arg.name}' is already typed as a decoded schema output; do not re-parse internal typed values.`,
            });
          }
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
        "Disallow `.transform(x => x)` or exact object-cloning `.transform(x => ({ a: x.a, b: x.b }))` no-ops on schemas.",
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
    function isIdentityBody(paramName, body) {
      const expr = unwrapExpression(body);
      if (expr?.type === "Identifier" && expr.name === paramName) return true;
      if (expr?.type === "ObjectExpression" && expr.properties.length >= 2) {
        return expr.properties.every(
          (p) =>
            p.type === "Property" &&
            !p.computed &&
            p.key?.type === "Identifier" &&
            p.value?.type === "MemberExpression" &&
            !p.value.computed &&
            p.value.object?.type === "Identifier" &&
            p.value.object.name === paramName &&
            p.value.property?.type === "Identifier" &&
            p.value.property.name === p.key.name
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
        if (!isFunctionLike(cb) || cb.params.length !== 1) return;
        const param = cb.params[0];
        if (param.type !== "Identifier") return;
        const returned =
          cb.body?.type === "BlockStatement" &&
          cb.body.body.length === 1 &&
          cb.body.body[0].type === "ReturnStatement"
            ? cb.body.body[0].argument
            : cb.body;
        if (isIdentityBody(param.name, returned)) {
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
    return {
      CallExpression(node) {
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
