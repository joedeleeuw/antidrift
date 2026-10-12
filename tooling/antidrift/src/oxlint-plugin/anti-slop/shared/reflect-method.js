function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}
/** Reports whether an identifier names a global binding no local declaration shadows. */
export function isUnshadowedGlobal(sourceCode, expression) {
  if (expression?.type !== "Identifier") return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}
function isGlobalReflect(sourceCode, expression) {
  return (
    expression.name === "Reflect" && isUnshadowedGlobal(sourceCode, expression)
  );
}
/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(sourceCode, callee, methodName) {
  if (
    !("property" in callee) ||
    !("object" in callee) ||
    !("computed" in callee)
  )
    return false;
  if (!isGlobalReflect(sourceCode, callee.object)) return false;
  const property = callee.property;
  return callee.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName;
}
