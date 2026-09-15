import { isAnyOrUnknownType, isJsonParseCall } from "./parse-input.mjs";

export function isGlobalJsonParse(node, services, checker) {
  if (!isJsonParseCall(node)) return false;
  const tsObject = services.esTreeNodeToTSNodeMap.get(node.callee.object);
  const symbol = tsObject && checker.getSymbolAtLocation(tsObject);
  return Boolean(
    symbol?.declarations?.some((declaration) =>
      /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/u.test(
        declaration.getSourceFile().fileName,
      ),
    ),
  );
}

export function parsedJsonOrigin(
  node,
  context,
  services,
  checker,
  seen = new Set(),
) {
  if (isGlobalJsonParse(node, services, checker)) return node;
  if (node?.type !== "Identifier") return null;
  let scope = context.sourceCode.getScope(node);
  while (scope && !scope.set.has(node.name)) scope = scope.upper;
  const variable = scope?.set.get(node.name);
  if (!variable || seen.has(variable)) return null;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type !== "Variable" || definition.parent.kind !== "const") {
    return null;
  }
  return parsedJsonOrigin(
    definition.node.init,
    context,
    services,
    checker,
    seen,
  );
}

export function parsedJsonTarget(node, context, services, checker) {
  if (!parsedJsonOrigin(node, context, services, checker)) return null;
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  const target = tsNode && checker.getContextualType(tsNode);
  if (!target || isAnyOrUnknownType(target)) return null;
  return checker.typeToString(target);
}
