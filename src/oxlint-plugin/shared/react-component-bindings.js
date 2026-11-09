import { findVariable, unwrapExpression } from "./scope.js";

const COMPONENT_WRAPPERS = new Set(["forwardRef", "memo"]);

function moduleExportName(node) {
  if (node?.type === "Identifier") return node.name;
  return typeof node?.value === "string" ? node.value : null;
}

function reactImportSpecifier(sourceCode, identifier) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (definition?.type !== "ImportBinding") return null;
  return definition.parent?.source?.value === "react" ? definition.node : null;
}

function isReactNamespace(sourceCode, node) {
  const specifier = reactImportSpecifier(sourceCode, node);
  return (
    specifier?.type === "ImportDefaultSpecifier" ||
    specifier?.type === "ImportNamespaceSpecifier" ||
    (specifier?.type === "ImportSpecifier" &&
      moduleExportName(specifier.imported) === "default")
  );
}

// Only React's own forwardRef/memo (named, aliased, default or namespace
// import) prove a component; a local helper spelled `memo` does not.
export function isComponentWrapperCall(sourceCode, node) {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const specifier = reactImportSpecifier(sourceCode, callee);
    return (
      specifier?.type === "ImportSpecifier" &&
      COMPONENT_WRAPPERS.has(moduleExportName(specifier.imported))
    );
  }
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    COMPONENT_WRAPPERS.has(callee.property.name) &&
    isReactNamespace(sourceCode, callee.object)
  );
}

function outerExpression(expression) {
  let outer = expression;
  while (unwrapExpression(outer.parent) === expression) {
    outer = outer.parent;
  }
  return outer;
}

function isComponentReference(identifier, name) {
  if (identifier === name) return true;
  const parent = identifier.parent;
  return (
    ((parent?.type === "JSXOpeningElement" ||
      parent?.type === "JSXClosingElement") &&
      parent.name === identifier) ||
    parent?.type === "ExportSpecifier" ||
    parent?.type === "ExportDefaultDeclaration"
  );
}

export function hasComponentBinding(sourceCode, owner) {
  let declaration = outerExpression(owner);
  const wrapper = declaration.parent;
  if (
    isComponentWrapperCall(sourceCode, wrapper) &&
    wrapper.arguments[0] === declaration
  ) {
    declaration = outerExpression(wrapper);
  }
  const parent = declaration.parent;
  const defaultExport = parent?.type === "ExportDefaultDeclaration";
  let name = declaration.id;
  if (declaration.type !== "FunctionDeclaration") {
    name =
      parent?.type === "VariableDeclarator" && parent.init === declaration
        ? parent.id
        : null;
  }
  if (name?.type !== "Identifier") return defaultExport;
  if (!defaultExport && !/^[A-Z]/u.test(name.name)) return false;
  const binding = findVariable(sourceCode, name);
  return (
    Boolean(binding) &&
    binding.references.every(({ identifier }) =>
      isComponentReference(identifier, name)
    )
  );
}
