export const importedOwnerSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["module", "export"],
    additionalProperties: false,
    properties: {
      module: { type: "string", minLength: 1 },
      export: { type: "string", minLength: 1 },
      member: { type: "string", minLength: 1 },
    },
  },
};

export function findVariable(context, node) {
  if (node?.type !== "Identifier") return null;
  for (
    let scope = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
  }
  return null;
}

export function importedOwner(context, node, owners, seen = new Set()) {
  if (node?.type === "MemberExpression" && !node.computed) {
    return importedOwner(
      context,
      node.object,
      owners
        .filter((owner) => owner.member === node.property.name)
        .map((owner) => ({ ...owner, member: undefined })),
      seen,
    );
  }
  const variable = findVariable(context, node);
  if (!variable || seen.has(variable)) return false;
  seen.add(variable);
  const definition = variable.defs[0];
  if (definition?.type === "ImportBinding") {
    let name =
      definition.node.imported?.name ?? definition.node.imported?.value;
    if (definition.node.type === "ImportDefaultSpecifier") name = "default";
    if (definition.node.type === "ImportNamespaceSpecifier") name = "*";
    return owners.some(
      (owner) =>
        !owner.member &&
        owner.module === definition.parent.source.value &&
        owner.export === name,
    );
  }
  if (
    definition?.type === "Variable" &&
    definition.parent.kind === "const" &&
    !variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  ) {
    return importedOwner(context, definition.node.init, owners, seen);
  }
  return false;
}
