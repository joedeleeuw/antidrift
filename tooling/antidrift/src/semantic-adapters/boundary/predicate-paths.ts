import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
  unwrapExpression,
} from "../kernel/syntax-node.ts";
import {
  hasParamRoot,
  isBindingIdentifier,
  memberExpressionPropertyName,
  staticPropertyName,
  syntaxDescendants,
} from "./binding-syntax.ts";

export function reflectGetParts(node: unknown) {
  const callee = syntaxField(node, "callee");
  if (
    !isSyntaxType(node, "CallExpression") ||
    !isSyntaxType(callee, "MemberExpression") ||
    identifierName(syntaxField(callee, "object")) !== "Reflect" ||
    staticPropertyName(syntaxField(callee, "property")) !== "get"
  ) {
    return null;
  }
  const [target, key] = syntaxChildren(node, "arguments");
  const name = staticPropertyName(key);
  return name === null ? null : { target, name };
}

export function staticMemberName(node: unknown): string | null {
  const property = syntaxField(node, "property");
  if (!syntaxField(node, "computed")) {
    return staticPropertyName(property);
  }
  const literal = syntaxField(property, "value");
  return isSyntaxType(property, "Literal") && typeof literal === "string"
    ? literal
    : null;
}

function keyedHelperCheck(
  node: unknown,
  valuePath: (argument: unknown) => readonly string[] | null
): string[] | null {
  if (!isSyntaxType(node, "CallExpression")) {
    return null;
  }
  const callArguments = syntaxChildren(node, "arguments");
  const key = callArguments.find(
    (argument) =>
      isSyntaxType(argument, "Literal") &&
      typeof syntaxField(argument, "value") === "string"
  );
  const keyName = syntaxText(key, "value");
  if (keyName === null) {
    return null;
  }
  for (const argument of callArguments) {
    if (argument === key || isSyntaxType(argument, "SpreadElement")) {
      continue;
    }
    const base = valuePath(argument);
    if (base) {
      return [...base, keyName];
    }
  }
  return null;
}

export function directAliasName(
  node: unknown,
  paramNames: ReadonlySet<string>
): string | null {
  const declaredName = identifierName(syntaxField(node, "id"));
  if (!isSyntaxType(node, "VariableDeclarator") || declaredName === null) {
    return null;
  }
  const initName = identifierName(unwrapExpression(syntaxField(node, "init")));
  return initName !== null && paramNames.has(initName) ? declaredName : null;
}

export function predicateValueNames(
  node: unknown,
  paramName: string
): Set<string> {
  const names = new Set([paramName]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of syntaxDescendants(node)) {
      const alias = directAliasName(current, names);
      if (alias && !names.has(alias)) {
        names.add(alias);
        changed = true;
      }
    }
  }
  return names;
}

export function identifierDeclarator(node: unknown) {
  const name = identifierName(syntaxField(node, "id"));
  return isSyntaxType(node, "VariableDeclarator") && name !== null
    ? { name, init: syntaxField(node, "init") }
    : null;
}

export class PredicatePaths {
  readonly paramNames: ReadonlySet<string>;
  readonly #aliasPaths = new Map<string, readonly string[]>();

  constructor(body: unknown, paramName: string) {
    this.paramNames = predicateValueNames(body, paramName);
  }

  pathOf(expression: unknown): readonly string[] | null {
    const node = unwrapExpression(expression);
    const name = identifierName(node);
    if (name !== null) {
      return this.paramNames.has(name)
        ? []
        : (this.#aliasPaths.get(name) ?? null);
    }
    if (isSyntaxType(node, "MemberExpression")) {
      const memberName = staticMemberName(node);
      if (memberName === null) {
        return null;
      }
      const base = this.pathOf(syntaxField(node, "object"));
      return base ? [...base, memberName] : null;
    }
    const reflected = reflectGetParts(node);
    if (!reflected) {
      return null;
    }
    const base = this.pathOf(reflected.target);
    return base ? [...base, reflected.name] : null;
  }

  recordAlias(name: string, init: unknown): boolean {
    const path = this.pathOf(init);
    if (!path?.length) {
      return false;
    }
    this.#aliasPaths.set(name, path);
    return true;
  }
}

export function destructuredTargetPropertyAliases(
  node: unknown,
  paramNames: ReadonlySet<string>,
  targetProps: ReadonlySet<string>
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const current of syntaxDescendants(node)) {
    const pattern = syntaxField(current, "id");
    if (
      !isSyntaxType(current, "VariableDeclarator") ||
      !isSyntaxType(pattern, "ObjectPattern") ||
      !hasParamRoot(syntaxField(current, "init"), paramNames)
    ) {
      continue;
    }
    for (const property of syntaxChildren(pattern, "properties")) {
      const propertyName = isSyntaxType(property, "Property")
        ? staticPropertyName(syntaxField(property, "key"))
        : null;
      const binding = syntaxField(property, "value");
      const aliasName = identifierName(
        isSyntaxType(binding, "AssignmentPattern")
          ? syntaxField(binding, "left")
          : binding
      );
      if (
        propertyName !== null &&
        targetProps.has(propertyName) &&
        aliasName !== null
      ) {
        aliases.set(aliasName, propertyName);
      }
    }
  }
  return aliases;
}

export function objectHasOwnPropertyName(
  node: unknown,
  paramNames: ReadonlySet<string>
): string | null {
  const callee = syntaxField(node, "callee");
  const method = staticPropertyName(syntaxField(callee, "property"));
  if (
    !isSyntaxType(node, "CallExpression") ||
    !isSyntaxType(callee, "MemberExpression") ||
    (method !== "hasOwn" && method !== "hasOwnProperty")
  ) {
    return null;
  }
  const [first, second] = syntaxChildren(node, "arguments");
  const receiver = syntaxField(callee, "object");
  if (identifierName(receiver) === "Object") {
    return hasParamRoot(first, paramNames) ? staticPropertyName(second) : null;
  }
  return hasParamRoot(receiver, paramNames) ? staticPropertyName(first) : null;
}

type TargetPropertyScope = {
  readonly paramNames: ReadonlySet<string>;
  readonly targetProps: ReadonlySet<string>;
  readonly propertyAliases: ReadonlyMap<string, string>;
};

function checkedTargetCandidate(
  current: unknown,
  scope: TargetPropertyScope
): string | null | undefined {
  const { paramNames } = scope;
  if (
    isSyntaxType(current, "BinaryExpression") &&
    syntaxField(current, "operator") === "in" &&
    hasParamRoot(syntaxField(current, "right"), paramNames)
  ) {
    return staticPropertyName(syntaxField(current, "left"));
  }
  const hasOwnName = objectHasOwnPropertyName(current, paramNames);
  if (hasOwnName !== null && scope.targetProps.has(hasOwnName)) {
    return hasOwnName;
  }
  if (
    isSyntaxType(current, "MemberExpression") &&
    hasParamRoot(current, paramNames)
  ) {
    return memberExpressionPropertyName(current);
  }
  const reflected = reflectGetParts(current);
  if (reflected && hasParamRoot(reflected.target, paramNames)) {
    return reflected.name;
  }
  const keyed = keyedHelperCheck(current, (argument) =>
    hasParamRoot(argument, paramNames) &&
    isSyntaxType(unwrapExpression(argument), "Identifier")
      ? []
      : null
  );
  if (keyed) {
    return keyed[0];
  }
  const aliasName = identifierName(current);
  return aliasName !== null && !isBindingIdentifier(current)
    ? scope.propertyAliases.get(aliasName)
    : null;
}

export function checkedTargetProperties(
  node: unknown,
  paramName: string,
  targetProps: ReadonlySet<string>
): Set<string> {
  const paramNames = predicateValueNames(node, paramName);
  const scope = {
    paramNames,
    targetProps,
    propertyAliases: destructuredTargetPropertyAliases(
      node,
      paramNames,
      targetProps
    ),
  };
  const checked = new Set<string>();
  for (const current of syntaxDescendants(node)) {
    const candidate = checkedTargetCandidate(current, scope);
    if (candidate != null && targetProps.has(candidate)) {
      checked.add(candidate);
    }
  }
  return checked;
}

export function checkedPropertyPaths(
  node: unknown,
  paramName: string
): Set<string> {
  const paths = new PredicatePaths(node, paramName);
  const checkedPath = (current: unknown): readonly string[] | null => {
    const declarator = identifierDeclarator(current);
    if (declarator) {
      paths.recordAlias(declarator.name, declarator.init);
      return null;
    }
    if (
      isSyntaxType(current, "BinaryExpression") &&
      syntaxField(current, "operator") === "in"
    ) {
      const base = paths.pathOf(syntaxField(current, "right"));
      const name = staticPropertyName(syntaxField(current, "left"));
      return base && name !== null ? [...base, name] : null;
    }
    if (isSyntaxType(current, "MemberExpression")) {
      return paths.pathOf(current);
    }
    return isSyntaxType(current, "CallExpression")
      ? (paths.pathOf(current) ??
          keyedHelperCheck(current, (argument) => paths.pathOf(argument)))
      : null;
  };
  const checked = new Set<string>();
  for (const current of syntaxDescendants(node)) {
    const path = checkedPath(current);
    if (path?.length) {
      checked.add(path.join("."));
    }
  }
  return checked;
}

export function callUsesPredicateParam(
  node: unknown,
  paramName: string
): boolean {
  const paramNames = new Set([paramName]);
  return syntaxChildren(node, "arguments").some(
    (argument) =>
      !isSyntaxType(argument, "SpreadElement") &&
      hasParamRoot(argument, paramNames)
  );
}
