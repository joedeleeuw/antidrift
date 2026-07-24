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
        const callee = node.callee;
        let hookName;
        if (callee.type === "Identifier" && directNames.has(callee.name)) {
          hookName = callee.name;
        } else if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.property.type === "Identifier" &&
          namespaceNames.has(callee.object.name) &&
          reactEffectHooks.has(callee.property.name)
        ) {
          hookName = callee.property.name;
        }
        if (hookName && node.arguments.length < 2) {
          context.report({
            node,
            message: `${hookName} must be called with a dependency array. Without it the effect runs on every render — pass [] or the real dependencies.`,
          });
        }
      },
    };
  },
};
