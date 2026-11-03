import { functionReturnsJsx } from "../shared/scope.js";

function collectPropNames(members, names) {
  for (const member of members) {
    if (
      member.type === "TSPropertySignature" &&
      member.key?.type === "Identifier"
    ) {
      names.add(member.key.name);
    }
  }
  return names;
}

function hasWidgetDirective(fnNode) {
  if (fnNode?.body?.type !== "BlockStatement") return false;
  for (const stmt of fnNode.body.body) {
    if (stmt.type !== "ExpressionStatement") break;
    const dir =
      stmt.directive ??
      (stmt.expression?.type === "Literal" &&
      typeof stmt.expression.value === "string"
        ? stmt.expression.value
        : null);
    if (!dir) break;
    if (dir === "widget") return true;
  }
  return false;
}

function extractOmittedKeys(typeNode, keys = new Set()) {
  if (
    typeNode?.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    typeNode.typeName.name === "Omit"
  ) {
    const keyArg = typeNode.typeArguments?.params?.[1];
    let parts = [];
    if (keyArg?.type === "TSUnionType") {
      parts = keyArg.types;
    } else if (keyArg) {
      parts = [keyArg];
    }
    for (const part of parts) {
      if (
        part?.type === "TSLiteralType" &&
        part.literal?.type === "Literal" &&
        typeof part.literal.value === "string"
      ) {
        keys.add(part.literal.value);
      }
    }
  }
  return keys;
}

function collectTypePropertyNames(
  typeNode,
  typeDeclarations,
  names = new Set(),
  seen = new Set()
) {
  if (!typeNode) return names;
  if (typeNode.type === "TSTypeLiteral") {
    return collectPropNames(typeNode.members, names);
  }
  if (typeNode.type === "TSInterfaceBody") {
    return collectPropNames(typeNode.body, names);
  }
  if (typeNode.type === "TSIntersectionType") {
    const omittedKeys = new Set();
    for (const part of typeNode.types) {
      extractOmittedKeys(part, omittedKeys);
      collectTypePropertyNames(part, typeDeclarations, names, seen);
    }
    for (const key of omittedKeys) {
      names.delete(key);
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

function checkComponent(node, typeDeclarations, context) {
  if (
    !functionReturnsJsx(node) ||
    hasWidgetDirective(node) ||
    node.params.length === 0 ||
    node.params.length > 2
  ) {
    return;
  }
  const max = context.options[0]?.max ?? 12;
  const first = node.params[0];
  let propCount = 0;
  if (first.type === "ObjectPattern") {
    propCount = first.properties.filter(
      (property) => property.type === "Property"
    ).length;
  }
  const annotationCount = collectTypePropertyNames(
    first.typeAnnotation?.typeAnnotation,
    typeDeclarations
  ).size;
  const total = Math.max(propCount, annotationCount);
  if (total > max) {
    context.report({
      node: first,
      message: `Component accepts ${total} props (max ${max}); group cohesive props or compose children instead.`,
    });
  }
}

export function createComponentPropChecks(context) {
  const typeDeclarations = new Map();

  const check = (node) => checkComponent(node, typeDeclarations, context);

  return {
    Program(node) {
      for (const stmt of node.body) {
        const decl =
          stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
        if (decl?.type === "TSInterfaceDeclaration" && decl.id?.name) {
          typeDeclarations.set(decl.id.name, decl.body);
        } else if (decl?.type === "TSTypeAliasDeclaration" && decl.id?.name) {
          typeDeclarations.set(decl.id.name, decl.typeAnnotation);
        }
      }
    },
    FunctionDeclaration: check,
    FunctionExpression: check,
    ArrowFunctionExpression: check,
  };
}
