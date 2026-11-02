import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable, unwrapExpression } from "../shared/scope.js";

export const requireConvexReturnValidatorRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Convex function registrations (`query`, `mutation`, `action`, `internal*`) to declare an explicit `returns` validator without `v.any()`.",
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
    const CONVEX_BUILDERS = new Set([
      "query",
      "mutation",
      "action",
      "internalQuery",
      "internalMutation",
      "internalAction",
    ]);
    const convexBindings = new Set();

    function isReturnsProperty(prop) {
      if (prop.type !== "Property") return false;
      if (!prop.computed && prop.key?.type === "Identifier") {
        return prop.key.name === "returns";
      }
      return prop.key?.type === "Literal" && prop.key.value === "returns";
    }

    function resolveConfigObject(argNode) {
      const expr = unwrapExpression(argNode);
      if (expr?.type === "ObjectExpression") return expr;
      if (expr?.type === "Identifier") {
        const variable = findVariable(sourceCode, expr);
        const init = unwrapExpression(variable?.defs?.[0]?.node?.init);
        if (init?.type === "ObjectExpression") return init;
      }
      return null;
    }

    function containsVAny(node) {
      let found = false;
      function visit(cur) {
        if (found || !cur || typeof cur !== "object") return;
        if (
          cur.type === "CallExpression" &&
          cur.callee?.type === "MemberExpression" &&
          cur.callee.object?.type === "Identifier" &&
          cur.callee.object.name === "v" &&
          cur.callee.property?.type === "Identifier" &&
          cur.callee.property.name === "any"
        ) {
          found = true;
          return;
        }
        for (const [k, val] of Object.entries(cur)) {
          if (k === "parent" || k === "range" || k === "loc") continue;
          if (Array.isArray(val)) {
            for (const item of val) visit(item);
          } else if (val && typeof val === "object") {
            visit(val);
          }
        }
      }
      visit(node);
      return found;
    }

    return {
      ImportDeclaration(node) {
        const src = node.source?.value;
        if (typeof src !== "string" || !src.includes("_generated/server")) {
          return;
        }
        for (const spec of node.specifiers ?? []) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported?.type === "Identifier" &&
            CONVEX_BUILDERS.has(spec.imported.name)
          ) {
            convexBindings.add(spec.local.name);
          }
        }
      },
      CallExpression(node) {
        if (
          node.callee?.type !== "Identifier" ||
          !convexBindings.has(node.callee.name)
        ) {
          return;
        }
        const calleeVar = findVariable(sourceCode, node.callee);
        if (
          calleeVar &&
          calleeVar.defs.length > 0 &&
          calleeVar.defs[0].type !== "ImportBinding"
        ) {
          return;
        }
        const config = resolveConfigObject(node.arguments[0]);
        if (!config) return;
        let effectiveReturns = null;
        let hasUnresolvedSpread = false;
        for (const prop of config.properties) {
          if (prop.type === "SpreadElement") {
            hasUnresolvedSpread = true;
            effectiveReturns = null;
          } else if (isReturnsProperty(prop)) {
            hasUnresolvedSpread = false;
            effectiveReturns = prop;
          }
        }
        if (!effectiveReturns) {
          if (hasUnresolvedSpread) return;
          context.report({
            node,
            message: `Convex ${node.callee.name} registration is missing a 'returns' validator.`,
          });
          return;
        }
        if (containsVAny(effectiveReturns.value)) {
          context.report({
            node: effectiveReturns.value,
            message:
              "Convex 'returns' validator uses `v.any()`, erasing the return contract; declare the exact validator shape.",
          });
        }
      },
    };
  },
};

export const noExplicitTypeArgumentsOnOwnedApiRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicit type arguments `<T>` on typed query/mutation hooks that already infer their contract from the registration.",
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
    const OWNED_PACKAGES = /^(?:convex\/react|@trpc\/|@tanstack\/react-query)/u;
    const HOOKS = new Set([
      "useQuery",
      "useSuspenseQuery",
      "useInfiniteQuery",
      "useMutation",
      "usePaginatedQuery",
    ]);
    const importedHooks = new Set();

    return {
      ImportDeclaration(node) {
        const src = node.source?.value;
        if (typeof src !== "string" || !OWNED_PACKAGES.test(src)) return;
        for (const spec of node.specifiers ?? []) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported?.type === "Identifier" &&
            HOOKS.has(spec.imported.name)
          ) {
            importedHooks.add(spec.local.name);
          }
        }
      },
      CallExpression(node) {
        const typeArgs = node.typeArguments ?? node.typeParameters;
        if (!typeArgs?.params?.length) return;
        if (
          node.callee?.type === "Identifier" &&
          importedHooks.has(node.callee.name)
        ) {
          context.report({
            node: typeArgs,
            message: `Do not pass explicit type arguments to '${node.callee.name}'; let the owned query/mutation registration supply the type.`,
          });
        }
      },
    };
  },
};

export const noSqlStringConcatRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow interpolated template literals or string concatenation in SQL execution calls.",
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
    const SQL_METHODS = new Set(["query", "execute", "raw", "unsafe"]);
    const SQL_RECEIVERS =
      /^(?:db|pool|client|conn|connection|tx|trx|sql|knex|prisma)$/iu;

    function isDynamicString(node) {
      const expr = unwrapExpression(node);
      if (!expr) return false;
      if (expr.type === "TemplateLiteral" && expr.expressions.length > 0) {
        return true;
      }
      return expr.type === "BinaryExpression" && expr.operator === "+";
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.type !== "Identifier" ||
          !SQL_METHODS.has(callee.property.name) ||
          callee.object?.type !== "Identifier" ||
          !SQL_RECEIVERS.test(callee.object.name)
        ) {
          return;
        }
        const firstArg = node.arguments[0];
        if (isDynamicString(firstArg)) {
          context.report({
            node: firstArg,
            message:
              "Do not build SQL queries with string concatenation or unparameterized template interpolation; use parameterized placeholders or a tagged SQL template.",
          });
        }
      },
    };
  },
};
