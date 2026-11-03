import { findVariable } from "../shared/scope.js";

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

export function importedOwner(context, node, owners, seen = new Set()) {
  if (node?.type === "MemberExpression" && !node.computed) {
    return importedOwner(
      context,
      node.object,
      owners
        .filter((owner) => owner.member === node.property.name)
        .map((owner) => ({ ...owner, member: undefined })),
      seen
    );
  }
  const binding = findVariable(context.sourceCode, node);
  if (!binding || seen.has(binding)) return false;
  seen.add(binding);
  const definition = binding.defs[0];
  if (definition?.type === "ImportBinding") {
    let name =
      definition.node.imported?.name ?? definition.node.imported?.value;
    if (definition.node.type === "ImportDefaultSpecifier") name = "default";
    if (definition.node.type === "ImportNamespaceSpecifier") name = "*";
    return owners.some(
      (owner) =>
        !owner.member &&
        owner.module === definition.parent.source.value &&
        owner.export === name
    );
  }
  if (
    definition?.type === "Variable" &&
    definition.parent.kind === "const" &&
    !binding.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  ) {
    return importedOwner(context, definition.node.init, owners, seen);
  }
  return false;
}
