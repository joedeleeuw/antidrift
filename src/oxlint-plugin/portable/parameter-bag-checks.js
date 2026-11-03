import { functionReturnsJsx } from "../shared/scope.js";

function collectMemberNames(members, names) {
  for (const member of members) {
    if (
      (member.type === "TSPropertySignature" ||
        member.type === "TSMethodSignature") &&
      member.key?.type === "Identifier"
    ) {
      names.add(member.key.name);
    }
  }
  return names;
}

function collectTypePropertyNames(
  typeNode,
  typeDeclarations,
  names = new Set(),
  seen = new Set()
) {
  if (!typeNode) return names;
  if (typeNode.type === "TSTypeLiteral") {
    return collectMemberNames(typeNode.members, names);
  }
  if (typeNode.type === "TSInterfaceBody") {
    return collectMemberNames(typeNode.body, names);
  }
  if (typeNode.type === "TSIntersectionType") {
    for (const part of typeNode.types) {
      collectTypePropertyNames(part, typeDeclarations, names, seen);
    }
    return names;
  }
  if (
    typeNode.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    !seen.has(typeNode.typeName.name)
  ) {
    seen.add(typeNode.typeName.name);
    collectTypePropertyNames(
      typeDeclarations.get(typeNode.typeName.name),
      typeDeclarations,
      names,
      seen
    );
  }
  return names;
}

export function recordProgramTypeDeclarations(programNode, typeDeclarations) {
  for (const stmt of programNode.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.body);
    } else if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
      typeDeclarations.set(decl.id.name, decl.typeAnnotation);
    }
  }
}

function parameterPropertyNames(parameter, typeDeclarations) {
  const names = new Set();
  if (parameter.type === "ObjectPattern") {
    for (const prop of parameter.properties) {
      if (prop.type === "Property" && prop.key?.type === "Identifier") {
        names.add(prop.key.name);
      }
    }
  }
  collectTypePropertyNames(
    parameter.typeAnnotation?.typeAnnotation,
    typeDeclarations,
    names
  );
  return names;
}

export function checkParameterBags(node, typeDeclarations, context) {
  const max = context.options[0]?.max ?? 10;
  if (functionReturnsJsx(node) || node.params.length === 0) return;
  for (const parameter of node.params) {
    const names = parameterPropertyNames(parameter, typeDeclarations);
    if (
      names.size > max &&
      (parameter.type === "ObjectPattern" ||
        parameter.typeAnnotation?.typeAnnotation?.type === "TSTypeLiteral")
    ) {
      context.report({
        node: parameter,
        message: `Function parameter bag accepts ${names.size} properties (max ${max}); group cohesive domain concepts or move behavior onto the owning object.`,
      });
    }
    if (names.size < 3) continue;
    const setters = [...names].filter((name) => /^set[A-Z]/u.test(name));
    const getters = [...names].filter((name) => /^get[A-Z]/u.test(name));
    if (setters.length >= 3 || (setters.length >= 2 && getters.length >= 1)) {
      const sample = [...setters, ...getters].slice(0, 4).join(", ");
      context.report({
        node: parameter,
        message: `Parameter bag accepts multiple foreign state callbacks (${sample}); return a state transition value or move the logic into the state owner.`,
      });
    }
  }
}
