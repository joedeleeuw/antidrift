import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  hasRuntimeSchemaProvenance,
  resolveSchemaBuilderCall,
  staticPropertyName,
} from "../shared/runtime-schema-libraries.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

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
const DECODED_VALUE_METHODS = new Set([
  "parse",
  "parseAsync",
  "decodeUnknownSync",
  "decodeSync",
]);
const REPARSE_METHODS = new Set([
  ...DECODED_VALUE_METHODS,
  "safeParse",
  "safeParseAsync",
]);

function isRawDeserializeCall(node) {
  const expr = unwrapExpression(node);
  if (expr?.type === "AwaitExpression") {
    return isRawDeserializeCall(expr.argument);
  }
  if (expr?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expr.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.type !== "Identifier" ||
    callee.object?.type !== "Identifier"
  ) {
    return false;
  }
  if (
    callee.property.name === "parse" &&
    /^(?:JSON|YAML)$/u.test(callee.object.name)
  ) {
    return true;
  }
  return (
    callee.property.name === "json" &&
    /^(?:res|response|req|request)$/iu.test(callee.object.name)
  );
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

function checkJsonStringFields(node, context) {
  const builder = resolveSchemaBuilderCall(node, context.sourceCode);
  if (
    builder?.method !== "object" ||
    builder.args[0]?.type !== "ObjectExpression"
  ) {
    return;
  }
  for (const property of builder.args[0].properties) {
    const name = staticPropertyName(property);
    if (
      name &&
      /[A-Za-z0-9]Json$|^json[A-Z]/u.test(name) &&
      resolveSchemaBuilderCall(property.value, context.sourceCode)?.method ===
        "string"
    ) {
      context.report({
        node: property,
        message: `Schema field '${name}' stores opaque JSON as a string; decode its structure at the boundary with a nested schema.`,
      });
    }
  }
}

export const noUnsafeDeserializeRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting raw JSON.parse / response.json() results directly to a domain type without schema decoding.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return {
      CallExpression(node) {
        checkJsonStringFields(node, context);
      },
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

function isFallbackLiteral(node) {
  return (
    node?.type === "Literal" ||
    node?.type === "ArrayExpression" ||
    node?.type === "ObjectExpression"
  );
}

function collectFallbackReturns(node, sourceCode, returns) {
  if (!node || isFunctionLike(node)) return true;
  if (node.type === "ThrowStatement") return false;
  if (node.type === "ReturnStatement") {
    returns.push(unwrapExpression(node.argument));
  }
  return (sourceCode.visitorKeys[node.type] ?? []).every((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.every((child) =>
      collectFallbackReturns(child, sourceCode, returns)
    );
  });
}

function isSilentFallback(expression, sourceCode) {
  const fallback = unwrapExpression(expression);
  if (isFallbackLiteral(fallback)) return true;
  if (!isFunctionLike(fallback)) return false;
  if (isFallbackLiteral(unwrapExpression(fallback.body))) return true;
  const returns = [];
  return (
    collectFallbackReturns(fallback.body, sourceCode, returns) &&
    returns.length > 0 &&
    returns.every(isFallbackLiteral)
  );
}

function checkSchemaCatch(node, context) {
  const callee = node.callee;
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.name === "catch" &&
    hasRuntimeSchemaProvenance(callee.object, context.sourceCode) &&
    isSilentFallback(node.arguments[0], context.sourceCode)
  ) {
    context.report({
      node,
      message:
        "Schema `.catch(fallback)` silently repairs invalid boundary input on read; reject invalid input instead.",
    });
  }
}

function isUnknownPreservingAssertionType(typeNode) {
  if (!typeNode) return false;
  if (
    typeNode.type === "TSUnknownKeyword" ||
    typeNode.type === "TSNullKeyword" ||
    typeNode.type === "TSUndefinedKeyword"
  ) {
    return true;
  }
  if (typeNode.type === "TSUnionType") {
    return typeNode.types.every(isUnknownPreservingAssertionType);
  }
  if (typeNode.type === "TSTypeLiteral") {
    return (
      typeNode.members.length > 0 &&
      typeNode.members.every(
        (m) =>
          m.type === "TSPropertySignature" &&
          m.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
      )
    );
  }
  return false;
}

function checkUnknownFunction(node, context) {
  const sourceCode = context.sourceCode;
  if (node.returnType?.typeAnnotation?.type === "TSTypePredicate") return;
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
        !isUnknownPreservingAssertionType(parent.typeAnnotation)
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

export const unknownInputMustBeDecodedRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting or probing `: unknown` boundary parameters into domain types without a schema decoder.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const checkFunction = (node) => checkUnknownFunction(node, context);

    return {
      CallExpression(node) {
        checkSchemaCatch(node, context);
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
};

function parseCallInfo(node, sourceCode) {
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
    callee.property?.type !== "Identifier" ||
    !isSchemaReceiver(callee.object, sourceCode)
  ) {
    return null;
  }
  const method = callee.property.name;
  if (!REPARSE_METHODS.has(method)) return null;
  return {
    method,
    returnsDecodedValue: DECODED_VALUE_METHODS.has(method),
    schemaText: sourceCode.getText(callee.object).replace(/\s+/gu, ""),
  };
}

function matchesInferredParameterSchema(def, schemaText, sourceCode) {
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

function isSchemaReceiver(expression, sourceCode) {
  if (hasRuntimeSchemaProvenance(expression, sourceCode)) return true;
  if (
    expression?.type !== "Identifier" ||
    /^(?:URL|Date|JSON|path)$/u.test(expression.name)
  ) {
    return false;
  }
  const definition = findVariable(sourceCode, expression)?.defs?.[0];
  return (
    definition?.node?.type === "VariableDeclarator" ||
    definition?.type === "Parameter"
  );
}

function isMappedSchemaDecode(node, sourceCode) {
  if (!hasRuntimeSchemaProvenance(node.callee.object, sourceCode)) return false;
  let callback = node.parent;
  if (callback?.type === "ReturnStatement" && callback.argument === node) {
    while (callback && !isFunctionLike(callback)) callback = callback.parent;
  } else if (
    callback?.type !== "ArrowFunctionExpression" ||
    callback.body !== node
  ) {
    return false;
  }
  const call = callback?.parent;
  if (
    call?.type !== "CallExpression" ||
    call.arguments[0] !== callback ||
    call.callee?.type !== "MemberExpression" ||
    call.callee.computed ||
    call.callee.property?.name !== "map"
  ) {
    return false;
  }
  const parameter = callback.params[0];
  const argument = node.arguments[0];
  return (
    parameter?.type === "Identifier" &&
    argument?.type === "Identifier" &&
    findVariable(sourceCode, parameter) === findVariable(sourceCode, argument)
  );
}

export const noRedundantZodParseRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow re-parsing a value with the same schema after `.parse()` / `.parseAsync()` or when already typed as `z.infer<typeof Schema>`.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;

    return {
      CallExpression(node) {
        const outer = parseCallInfo(node, sourceCode);
        if (!outer) return;
        if (
          outer.returnsDecodedValue &&
          isMappedSchemaDecode(node, sourceCode)
        ) {
          context.report({
            node,
            message:
              "Decode the collection once with an array schema instead of `.map(item => Schema.parse(item))`.",
          });
          return;
        }
        const arg = unwrapExpression(node.arguments[0]);
        const inner = parseCallInfo(arg, sourceCode);
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
          const initInfo = parseCallInfo(def.node.init, sourceCode);
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
        if (matchesInferredParameterSchema(def, outer.schemaText, sourceCode)) {
          context.report({
            node,
            message: `Parameter '${arg.name}' is already typed as a decoded schema output; do not re-parse internal typed values.`,
          });
        }
      },
    };
  },
};

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

export const noIdentitySchemaTransformRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `.transform(x => x)` or exhaustive destructuring `.transform(({ a, b }) => ({ a, b }))` no-ops on schemas.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};

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
    schema: SCOPE_SCHEMA,
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
