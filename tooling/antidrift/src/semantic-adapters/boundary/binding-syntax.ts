import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
  unwrapExpression,
} from "../kernel/syntax-node.ts";

const WALK_SKIPPED_KEYS = new Set(["parent", "loc", "range"]);

export function assignmentTarget(node: unknown) {
  return isSyntaxType(node, "AssignmentPattern")
    ? syntaxField(node, "left")
    : node;
}

function nestedObjectPattern(node: unknown) {
  const target = assignmentTarget(node);
  return isSyntaxType(target, "ObjectPattern") ? target : null;
}

function patternPropertyBinding(property: unknown) {
  return isSyntaxType(property, "RestElement")
    ? syntaxField(property, "argument")
    : syntaxField(property, "value");
}

export function collectObjectPatternBindingNames(
  pattern: unknown,
  names: Set<string>
): void {
  for (const property of syntaxChildren(pattern, "properties")) {
    const name = identifierName(
      assignmentTarget(patternPropertyBinding(property))
    );
    if (name) {
      names.add(name);
    }
    const nested = isSyntaxType(property, "Property")
      ? nestedObjectPattern(syntaxField(property, "value"))
      : null;
    if (nested) {
      collectObjectPatternBindingNames(nested, names);
    }
  }
}

export function collectBindingNames(node: unknown, names: Set<string>): void {
  const target = assignmentTarget(node);
  const name = identifierName(target);
  if (name !== null) {
    names.add(name);
    return;
  }
  if (isSyntaxType(target, "RestElement")) {
    collectBindingNames(syntaxField(target, "argument"), names);
    return;
  }
  if (isSyntaxType(target, "ArrayPattern")) {
    for (const element of syntaxChildren(target, "elements")) {
      collectBindingNames(element, names);
    }
    return;
  }
  if (isSyntaxType(target, "ObjectPattern")) {
    collectObjectPatternBindingNames(target, names);
  }
}

export function collectBindingIdentifiers(
  node: unknown,
  identifiers: unknown[]
): void {
  const target = assignmentTarget(node);
  if (isSyntaxType(target, "Identifier")) {
    identifiers.push(target);
    return;
  }
  if (isSyntaxType(target, "RestElement")) {
    collectBindingIdentifiers(syntaxField(target, "argument"), identifiers);
    return;
  }
  if (isSyntaxType(target, "ArrayPattern")) {
    for (const element of syntaxChildren(target, "elements")) {
      collectBindingIdentifiers(element, identifiers);
    }
    return;
  }
  const properties = isSyntaxType(target, "ObjectPattern")
    ? syntaxChildren(target, "properties")
    : [];
  for (const property of properties) {
    collectBindingIdentifiers(patternPropertyBinding(property), identifiers);
  }
}

export function memberExpressionRootName(expression: unknown): string | null {
  let current = unwrapExpression(expression);
  while (isSyntaxType(current, "MemberExpression")) {
    current = unwrapExpression(syntaxField(current, "object"));
  }
  return identifierName(current);
}

export function* syntaxDescendants(root: unknown): Generator<SyntaxNode> {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isSyntaxNode(node)) {
      continue;
    }
    yield node;
    const children: unknown[] = [];
    for (const [key, child] of Object.entries(node)) {
      if (WALK_SKIPPED_KEYS.has(key)) {
        continue;
      }
      const fieldChildren = Array.isArray(child)
        ? syntaxChildren(node, key)
        : [child];
      for (const fieldChild of fieldChildren) {
        children.push(fieldChild);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
}

export function walkNode(node: unknown, visit: (node: unknown) => void): void {
  for (const current of syntaxDescendants(node)) {
    visit(current);
  }
}

export function isNullishLiteral(node: unknown): boolean {
  return (
    (isSyntaxType(node, "Literal") && syntaxField(node, "value") === null) ||
    identifierName(node) === "undefined"
  );
}

export function hasParamRoot(
  expression: unknown,
  paramNames: ReadonlySet<string>
): boolean {
  const root = memberExpressionRootName(expression);
  return root !== null && paramNames.has(root);
}

export function staticPropertyName(node: unknown): string | null {
  if (
    isSyntaxType(node, "Identifier") ||
    isSyntaxType(node, "PrivateIdentifier")
  ) {
    return syntaxText(node, "name");
  }
  const literal = syntaxField(node, "value");
  return isSyntaxType(node, "Literal") && typeof literal === "string"
    ? literal
    : null;
}

export function memberExpressionPropertyName(node: unknown): string | null {
  const unwrapped = unwrapExpression(node);
  return isSyntaxType(unwrapped, "MemberExpression")
    ? staticPropertyName(syntaxField(unwrapped, "property"))
    : null;
}

export function isBindingIdentifier(node: unknown): boolean {
  const parent = syntaxField(node, "parent");
  const grandparent = syntaxField(parent, "parent");
  if (isSyntaxType(parent, "VariableDeclarator")) {
    return syntaxField(parent, "id") === node;
  }
  if (isSyntaxType(parent, "Property")) {
    return (
      syntaxField(parent, "value") === node &&
      isSyntaxType(grandparent, "ObjectPattern")
    );
  }
  return (
    isSyntaxType(parent, "AssignmentPattern") &&
    syntaxField(parent, "left") === node &&
    isSyntaxType(grandparent, "Property")
  );
}
