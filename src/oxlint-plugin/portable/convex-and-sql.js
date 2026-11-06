import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  constInitializer,
  findVariable,
  staticPropertyKey,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";
import {
  closedStringLiteralUnionValues,
  getResolvedType,
  getTypeServices,
  isBroadResolvedType,
  resolvedTypeTexts,
} from "../shared/type-services.js";
import { findDescendant, isMemberAccess } from "./ast.js";
import { rootIdentifier } from "./static-resolution.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

const CONVEX_BUILDER =
  /^(?:query|mutation|action|internal(?:Query|Mutation|Action))$/u;

class ConvexRegistrations {
  constructor(context) {
    this.context = context;
    this.sourceCode = this.context.sourceCode;
    this.convexBindings = new Set();
  }
  resolveRegistration = (argNode) => {
    const expr = unwrapExpression(argNode);
    if (expr?.type === "ObjectExpression") return expr;
    if (expr?.type === "Identifier") {
      const binding = findVariable(this.sourceCode, expr);
      const init = unwrapExpression(binding?.defs?.[0]?.node?.init);
      if (init?.type === "ObjectExpression") return init;
    }
    return null;
  };

  containsVAny = (node) =>
    findDescendant(
      node,
      (candidate) =>
        candidate.type === "CallExpression" &&
        isMemberAccess(candidate.callee, "v", "any")
    ) !== null;

  visitImportDeclaration = (node) => {
    const src = node.source?.value;
    if (typeof src !== "string" || !src.includes("_generated/server")) {
      return;
    }
    for (const spec of node.specifiers ?? []) {
      if (
        spec.type === "ImportSpecifier" &&
        spec.imported?.type === "Identifier" &&
        CONVEX_BUILDER.test(spec.imported.name)
      ) {
        this.convexBindings.add(spec.local.name);
      }
    }
  };

  visitCallExpression = (node) => {
    if (
      node.callee?.type !== "Identifier" ||
      !this.convexBindings.has(node.callee.name)
    ) {
      return;
    }
    const definition = findVariable(this.sourceCode, node.callee)?.defs?.[0];
    if (definition && definition.type !== "ImportBinding") return;
    const config = this.resolveRegistration(node.arguments[0]);
    if (!config) return;
    let effectiveReturns = null;
    let hasUnresolvedSpread = false;
    for (const prop of config.properties) {
      if (prop.type === "SpreadElement") {
        hasUnresolvedSpread = true;
        effectiveReturns = null;
      } else if (staticPropertyKey(prop) === "returns") {
        hasUnresolvedSpread = false;
        effectiveReturns = prop;
      }
    }
    if (!effectiveReturns) {
      if (hasUnresolvedSpread) return;
      this.context.report({
        node,
        message: `Convex ${node.callee.name} registration is missing a 'returns' validator.`,
      });
      return;
    }
    if (this.containsVAny(effectiveReturns.value)) {
      this.context.report({
        node: effectiveReturns.value,
        message:
          "Convex 'returns' validator uses `v.any()`, erasing the return contract; declare the exact validator shape.",
      });
    }
  };
  listeners() {
    return {
      ImportDeclaration: this.visitImportDeclaration,
      CallExpression: this.visitCallExpression,
    };
  }
}

export const requireConvexReturnValidatorRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Convex function registrations (`query`, `mutation`, `action`, `internal*`) to declare an explicit `returns` validator without `v.any()`.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new ConvexRegistrations(context).listeners();
  },
};

const OWNED_PACKAGES =
  /^(?:convex\/react|@trpc\/|@tanstack\/react-query|swr|@apollo\/client|urql|@reduxjs\/toolkit\/query)/u;
const INFERRED_QUERY_HOOK = /^use(?:Suspense|Infinite)?Query$/u;
const OWNED_HOOK =
  /^use(?:[A-Z]\w*)?(?:Query|Queries|PaginatedQuery|InfiniteQuery|LazyQuery|Mutation|SWR)$/u;
const TRPC_HOOK =
  /^use(?:(?:Suspense|Infinite|Lazy)?Query|Queries|Mutation|Subscription)$/u;
const TRPC_ROOT = /^(?:trpc|api)$/u;

function hasConcreteAstReturnType(fnOrIdent, sourceCode) {
  const expr = unwrapExpression(fnOrIdent);
  const decl =
    expr?.type === "Identifier"
      ? findVariable(sourceCode, expr)?.defs?.[0]?.node
      : expr;
  const ann = decl?.returnType?.typeAnnotation;
  if (!ann) return false;
  return (
    ann.type !== "TSAnyKeyword" &&
    ann.type !== "TSUnknownKeyword" &&
    ann.type !== "TSNeverKeyword"
  );
}

function fnReturnsConcreteType(fnNode, sourceCode) {
  if (!fnNode) return false;
  const services = getTypeServices(sourceCode);
  const signature = getResolvedType(
    fnNode,
    sourceCode
  )?.getCallSignatures?.()[0];
  if (!services || !signature) {
    return hasConcreteAstReturnType(fnNode, sourceCode);
  }
  if (isBroadResolvedType(fnNode, sourceCode)) {
    return false;
  }
  const returned = services.checker.getReturnTypeOfSignature(signature);
  const awaited = services.checker.getAwaitedType?.(returned) ?? returned;
  const text = services.checker.typeToString(awaited);
  return (
    text !== "any" &&
    text !== "unknown" &&
    text !== "never" &&
    text !== "never[]"
  );
}

function queryFnReturnsConcreteType(options, sourceCode) {
  const queryFn = options?.properties?.find(
    (property) => staticPropertyKey(property) === "queryFn"
  );
  return fnReturnsConcreteType(queryFn?.value, sourceCode);
}

function mutationRegistrationSuppliesType(node, options, sourceCode) {
  const mutationFn = options?.properties?.find(
    (property) => staticPropertyKey(property) === "mutationFn"
  );
  if (
    options?.type !== "ObjectExpression" ||
    !fnReturnsConcreteType(mutationFn?.value, sourceCode)
  ) {
    return false;
  }
  const typeArgs = node.typeArguments ?? node.typeParameters;
  if (typeArgs.params.length < 3) return true;
  const expression = unwrapExpression(mutationFn.value);
  const declaration =
    expression?.type === "Identifier"
      ? findVariable(sourceCode, expression)?.defs?.[0]?.node
      : expression;
  const mutationFunction =
    declaration?.type === "VariableDeclarator"
      ? unwrapExpression(declaration.init)
      : declaration;
  return (mutationFunction?.params ?? []).every(
    (parameter) => parameter.typeAnnotation
  );
}

function isTrpcRoot(identifier, sourceCode) {
  if (!identifier) return false;
  if (TRPC_ROOT.test(identifier.name)) return true;
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  const source = definition?.parent?.source?.value;
  const init = unwrapExpression(definition?.node?.init);
  return (
    (typeof source === "string" && /trpc/iu.test(source)) ||
    (init?.type === "CallExpression" &&
      (init.callee?.name ?? "").startsWith("createTRPC"))
  );
}

function ownedApiCallee(node, importedHooks, sourceCode) {
  const callee = node.callee;
  const options = unwrapExpression(node.arguments[0]);
  if (callee?.type === "Identifier" && importedHooks.has(callee.name)) {
    const importedName = importedHooks.get(callee.name);
    if (importedName === "useSWR") {
      return fnReturnsConcreteType(node.arguments[1], sourceCode)
        ? callee.name
        : null;
    }
    if (importedName === "useMutation") {
      return mutationRegistrationSuppliesType(node, options, sourceCode)
        ? callee.name
        : null;
    }
    const inlineQuery =
      INFERRED_QUERY_HOOK.test(importedName) &&
      options?.type === "ObjectExpression";
    return !inlineQuery || queryFnReturnsConcreteType(options, sourceCode)
      ? callee.name
      : null;
  }
  if (
    callee?.type === "Identifier" &&
    OWNED_HOOK.test(callee.name) &&
    queryFnReturnsConcreteType(options, sourceCode)
  ) {
    return callee.name;
  }
  const method = staticPropertyName(callee);
  if (TRPC_HOOK.test(method)) {
    return isTrpcRoot(rootIdentifier(callee), sourceCode) ? method : null;
  }
  return method === "getQueryData" && staticPropertyName(options) === "queryKey"
    ? method
    : null;
}

function importedHookName(spec) {
  if (spec.type === "ImportSpecifier" && spec.imported?.type === "Identifier") {
    return spec.imported.name;
  }
  return spec.type === "ImportDefaultSpecifier" ? spec.local.name : "";
}

export const noExplicitTypeArgumentsOnOwnedApiRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicit type arguments `<T>` on typed query/mutation hooks and query-key reads that already infer their contract from the registration.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const importedHooks = new Map();
    return {
      ImportDeclaration(node) {
        const src = node.source?.value;
        if (typeof src !== "string" || !OWNED_PACKAGES.test(src)) return;
        for (const spec of node.specifiers ?? []) {
          const importedName = importedHookName(spec);
          if (OWNED_HOOK.test(importedName)) {
            importedHooks.set(spec.local.name, importedName);
          }
        }
      },
      CallExpression(node) {
        const typeArgs = node.typeArguments ?? node.typeParameters;
        if (!typeArgs?.params?.length) return;
        const name = ownedApiCallee(node, importedHooks, context.sourceCode);
        if (!name) return;
        context.report({
          node: typeArgs,
          message: `Do not pass explicit type arguments to '${name}'; let the owned query/mutation registration supply the type.`,
        });
      },
    };
  },
};

const SQL_STATEMENT =
  /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/isu;
const SQL_KEYWORD =
  /\b(?:select|insert|update|delete|from|where|create|alter|drop|values)\b/iu;
const SQL_SINK_METHOD =
  /^(?:query|execute|raw|unsafe|prepare|\$queryRawUnsafe|\$executeRawUnsafe)$/u;
const SQL_TEXT_METHOD = /^(?:exec|all|get|run|sql)$/u;
const SQL_RECEIVERS =
  /^(?:db|database|pool|client|conn|connection|tx|trx|sql|knex|prisma|sqlite)$/iu;
const SQL_TAG = /(?:^|\.)sql$/iu;
const BOUND_SCALAR_TYPE =
  /^(?:number|bigint|boolean|true|false|-?\d[\d_.]*n?)$/u;
const SQL_CONCAT_MESSAGE =
  "Do not build SQL queries with string concatenation or unparameterized template interpolation; use parameterized placeholders or a tagged SQL template.";

const CLOSED_ANNOTATION_TYPE =
  /^(?:TS(?:Number|BigInt|Boolean)Keyword|TSLiteralType)$/u;

function hasClosedAnnotation(expression, sourceCode) {
  const annotation = findVariable(sourceCode, expression)?.defs?.[0]?.name
    ?.typeAnnotation?.typeAnnotation;
  const parts =
    annotation?.type === "TSUnionType" ? annotation.types : [annotation];
  return parts.every((part) => CLOSED_ANNOTATION_TYPE.test(part?.type ?? ""));
}

function isPlaceholderList(expression) {
  return (
    expression?.type === "CallExpression" &&
    staticPropertyName(expression.callee) === "join" &&
    findDescendant(
      expression.callee.object,
      (candidate) => candidate.type === "Literal" && candidate.value === "?"
    ) !== null
  );
}

function staticText(expression) {
  if (expression?.type === "TemplateLiteral") {
    return expression.expressions.length === 0
      ? expression.quasis[0].value.cooked
      : null;
  }
  return typeof expression?.value === "string" ? expression.value : null;
}

function isStaticString(expression) {
  return staticText(expression) !== null;
}

class SqlInterpolations {
  constructor(context) {
    const options = context.options[0] ?? {};
    this.context = context;
    this.sourceCode = context.sourceCode;
    this.safeMembers = new Set(options.safeIdentifierMembers ?? []);
    this.safeTags = new Set(options.safeTemplateTags ?? []);
    this.reported = new Set();
  }

  isSafeExpression = (node) => {
    const expression = unwrapExpression(node);
    const resolved =
      expression?.type === "Identifier"
        ? unwrapExpression(constInitializer(this.sourceCode, expression))
        : expression;
    if (
      resolved?.type === "Literal" ||
      isStaticString(resolved) ||
      isPlaceholderList(resolved) ||
      this.safeMembers.has(staticPropertyName(expression)) ||
      this.safeMembers.has(this.sourceCode.getText(expression)) ||
      (expression?.type === "Identifier" &&
        hasClosedAnnotation(expression, this.sourceCode)) ||
      closedStringLiteralUnionValues(expression, this.sourceCode)
    ) {
      return true;
    }
    const typeTexts = resolvedTypeTexts(expression, this.sourceCode) ?? [];
    return (
      typeTexts.length > 0 &&
      typeTexts.every((text) => BOUND_SCALAR_TYPE.test(text))
    );
  };

  templateState = (template) => {
    const quasis = template.quasis.map((quasi) => quasi.value?.raw ?? "");
    const isUnsafe = () =>
      template.expressions.some(
        (expression, index) =>
          !quasis[index].endsWith("$") && !this.isSafeExpression(expression)
      );
    return { text: quasis.join(" ? "), isUnsafe };
  };

  concatState = (binary) => {
    const operands = [];
    const pending = [binary];
    while (pending.length > 0) {
      const current = unwrapExpression(pending.pop());
      if (current?.type === "BinaryExpression" && current.operator === "+") {
        pending.push(current.right, current.left);
      } else {
        operands.push(current);
      }
    }
    const dynamic = operands.filter((operand) => !isStaticString(operand));
    const text = operands
      .map((operand) => staticText(operand) ?? "?")
      .join(" ");
    return {
      text,
      isUnsafe: () =>
        dynamic.length > 0 && !dynamic.every(this.isSafeExpression),
      stringy: operands.some(isStaticString),
    };
  };

  dynamicState = (node) => {
    const expression = unwrapExpression(node);
    if (expression?.type === "TemplateLiteral") {
      return expression.expressions.length > 0
        ? this.templateState(expression)
        : null;
    }
    if (
      expression?.type === "BinaryExpression" &&
      expression.operator === "+"
    ) {
      const state = this.concatState(expression);
      return state.stringy ? state : null;
    }
    return null;
  };

  report = (node) => {
    if (this.reported.has(node)) return;
    this.reported.add(node);
    this.context.report({ node, message: SQL_CONCAT_MESSAGE });
  };

  isSqlReceiver = (receiver) => {
    const expression = unwrapExpression(receiver);
    const name =
      expression?.type === "Identifier"
        ? expression.name
        : staticPropertyName(expression);
    return (
      SQL_RECEIVERS.test(name) ||
      this.safeTags.has(this.sourceCode.getText(expression))
    );
  };

  visitCallExpression = (node) => {
    const callee = node.callee;
    const method = staticPropertyName(callee);
    if (
      callee?.type !== "MemberExpression" ||
      (!SQL_SINK_METHOD.test(method) && !SQL_TEXT_METHOD.test(method)) ||
      !this.isSqlReceiver(callee.object)
    ) {
      return;
    }
    const firstArg = node.arguments[0];
    const state = this.dynamicState(firstArg);
    if (
      state &&
      (SQL_SINK_METHOD.test(method) || SQL_KEYWORD.test(state.text)) &&
      state.isUnsafe()
    ) {
      this.report(unwrapExpression(firstArg));
    }
  };

  visitStatementText = (node) => {
    const parent = node.parent;
    const nested =
      node.type === "BinaryExpression"
        ? parent?.type === "BinaryExpression" && parent.operator === "+"
        : parent?.type === "TaggedTemplateExpression" &&
          (this.safeTags.has(this.sourceCode.getText(parent.tag)) ||
            SQL_TAG.test(this.sourceCode.getText(parent.tag)));
    const state = nested ? null : this.dynamicState(node);
    if (state && SQL_STATEMENT.test(state.text) && state.isUnsafe()) {
      this.report(node);
    }
  };

  listeners() {
    return {
      CallExpression: this.visitCallExpression,
      TemplateLiteral: this.visitStatementText,
      BinaryExpression: this.visitStatementText,
    };
  }
}

export const noSqlStringConcatRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow interpolated template literals or string concatenation that build SQL statements or reach SQL execution calls.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          safeIdentifierMembers: { type: "array", items: { type: "string" } },
          safeTemplateTags: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new SqlInterpolations(context).listeners();
  },
};
