const reactEffectHooks = new Set(["useEffect", "useLayoutEffect"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a dependency array for React effect hooks. A missing array runs the effect on every render.",
    },
    schema: [],
  },
  create(context) {
    const directNames = new Set();
    const namespaceNames = new Set();
    function resolveEffectHookName(callee) {
      if (callee.type === "Identifier" && directNames.has(callee.name)) {
        return callee.name;
      }
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier" &&
        namespaceNames.has(callee.object.name) &&
        reactEffectHooks.has(callee.property.name)
      ) {
        return callee.property.name;
      }
      return undefined;
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            reactEffectHooks.has(specifier.imported.name)
          ) {
            directNames.add(specifier.local.name);
          } else if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            namespaceNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const hookName = resolveEffectHookName(node.callee);
        if (hookName && node.arguments.length < 2) {
          context.report({
            node,
            message: `${hookName} must declare its dependency array. Pass the dependencies the effect reads. If every-render execution is intentional, keep it and suppress antidrift/require-effect-deps with a reason rather than adding [].`,
          });
        }
      },
    };
  },
};
