export function missingTypeServicesVisitors(context, ruleName) {
  return {
    Program(node) {
      context.report({
        node,
        message: `antidrift/${ruleName} requires TypeScript parser services. Use @joedeleeuw/antidrift createConfig(...) or configure @typescript-eslint/parser with projectService/project.`,
      });
    },
  };
}
export function requireTypeServices(context) {
  const services = context.sourceCode?.parserServices ?? context.parserServices;
  if (services?.program && services.esTreeNodeToTSNodeMap) {
    return services;
  }
  return null;
}
