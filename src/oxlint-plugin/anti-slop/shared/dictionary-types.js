const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set([
  "Readonly",
  "Partial",
  "Required",
  "NonNullable",
]);
function declaredStatement(statement) {
  return statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;
}
export function createTypeEnvironment(program) {
  const aliases = new Map();
  const shadowedBuiltIns = new Set();
  for (const statement of program.body) {
    const declaration = declaredStatement(statement);
    if (declaration?.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        if (BUILT_INS.has(specifier.local.name))
          shadowedBuiltIns.add(specifier.local.name);
      }
      continue;
    }
    if (declaration?.type === "TSTypeAliasDeclaration") {
      const existing = aliases.get(declaration.id.name);
      if (existing === undefined) aliases.set(declaration.id.name, declaration);
      else shadowedBuiltIns.add(declaration.id.name);
      if (BUILT_INS.has(declaration.id.name))
        shadowedBuiltIns.add(declaration.id.name);
      continue;
    }
    if (
      declaration?.type === "TSInterfaceDeclaration" ||
      declaration?.type === "TSEnumDeclaration"
    ) {
      if (BUILT_INS.has(declaration.id.name))
        shadowedBuiltIns.add(declaration.id.name);
      continue;
    }
    if (
      (declaration?.type === "ClassDeclaration" ||
        declaration?.type === "FunctionDeclaration") &&
      declaration.id !== null
    ) {
      if (BUILT_INS.has(declaration.id.name))
        shadowedBuiltIns.add(declaration.id.name);
    }
  }
  return { aliases, shadowedBuiltIns };
}
function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}
function isBuiltIn(name, environment) {
  return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}
function isUnappliedReferenceTo(type, name) {
  const unwrapped = unwrapTransparentType(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === name &&
    (unwrapped.typeArguments === null ||
      unwrapped.typeArguments === undefined ||
      unwrapped.typeArguments.params.length === 0)
  );
}
function unwrapTransparentType(type) {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}
function resolvedSubstitutionArgument(type, base, resolving = new Set()) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type !== "TSTypeReference") return type;
  const name = typeReferenceName(unwrapped);
  if (name === null || resolving.has(name)) return type;
  const substitution = base.get(name);
  if (substitution === undefined) return type;
  const nextResolving = new Set(resolving);
  nextResolving.add(name);
  return resolvedSubstitutionArgument(substitution, base, nextResolving);
}
function aliasSubstitution(alias, type, base) {
  const typeParameters = alias.typeParameters?.params ?? [];
  const arguments_ = type.typeArguments?.params ?? [];
  const next = new Map(base);
  for (const [index, parameter] of typeParameters.entries()) {
    const argument = arguments_[index] ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next));
  }
  return next;
}
function dictionaryValueTypes(
  type,
  environment,
  substitutions,
  resolvingAliases
) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member) =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
        : []
    );
  }
  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions }];
  }
  if (unwrapped.type !== "TSTypeReference") return [];
  const name = typeReferenceName(unwrapped);
  if (name === null) return [];
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValueTypes(
          substitution,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? []
      : dictionaryValueTypes(
          wrapped,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    const recordEntryType = unwrapped.typeArguments?.params[1] ?? null;
    return recordEntryType === null
      ? []
      : [{ type: recordEntryType, substitutions }];
  }
  if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
    const source = unwrapped.typeArguments?.params[0];
    return source === undefined
      ? []
      : dictionaryValueTypes(
          source,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return [];
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return [];
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return dictionaryValueTypes(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}
function resolvesToDictionary(
  type,
  environment,
  substitutions,
  resolvingAliases
) {
  return (
    dictionaryValueTypes(type, environment, substitutions, resolvingAliases)
      .length > 0
  );
}
export function classifyWideningTarget(type, environment) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some(
      (member) => member.type === "TSIndexSignature"
    )
      ? { kind: "open dictionary" }
      : unwrapped.members.length > 0
        ? { kind: "anonymous object" }
        : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(unwrapped.constraint, environment, new Map())
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyWideningTarget(wrapped, environment);
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    return hasBroadRecordKey(unwrapped, environment, new Map())
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined) return null;
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    const substitutions = aliasSubstitution(alias, unwrapped, new Map());
    return substitutions !== null &&
      resolvesToDictionary(
        alias.typeAnnotation,
        environment,
        substitutions,
        new Set([name])
      )
      ? { kind: "generic container" }
      : null;
  }
  const substitutions = aliasSubstitution(alias, unwrapped, new Map());
  if (substitutions === null) return null;
  const resolved = classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    substitutions,
    new Set([name])
  );
  return resolved;
}
function hasBroadRecordKey(type, environment, substitutions) {
  const key = type.typeArguments?.params[0];
  return key === undefined
    ? false
    : isBroadMappedKey(key, environment, substitutions);
}
function isBroadMappedKey(
  type,
  environment,
  substitutions,
  resolvingAliases = new Set()
) {
  if (type === null || type === undefined) return false;
  const unwrapped = unwrapTransparentType(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every((member) =>
      isBroadMappedKey(member, environment, substitutions, resolvingAliases)
    );
  }
  if (unwrapped.type !== "TSTypeReference") return false;
  const name = typeReferenceName(unwrapped);
  if (name === null) return false;
  const substitution = substitutions.get(name);
  if (
    substitution !== undefined &&
    !isUnappliedReferenceTo(substitution, name)
  ) {
    return isBroadMappedKey(
      substitution,
      environment,
      substitutions,
      resolvingAliases
    );
  }
  if (name === "PropertyKey" && isBuiltIn(name, environment)) {
    return true;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return false;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return false;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return isBroadMappedKey(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}
function classifyAliasBroadTarget(
  type,
  environment,
  substitutions,
  resolvingAliases
) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some(
      (member) => member.type === "TSIndexSignature"
    )
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(unwrapped.constraint, environment, substitutions)
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : classifyAliasBroadTarget(
          substitution,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyAliasBroadTarget(
          wrapped,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    return hasBroadRecordKey(unwrapped, environment, substitutions)
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}
export function isPopulatedObjectExpression(expression) {
  let current = expression;
  while (
    current &&
    (current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.expression;
  }
  if (!current) {
    return false;
  }
  if (
    current.type === "CallExpression" &&
    current.callee.type === "MemberExpression" &&
    !current.callee.computed &&
    current.callee.object.type === "Identifier" &&
    current.callee.object.name === "Object" &&
    current.callee.property.type === "Identifier" &&
    current.callee.property.name === "freeze" &&
    current.arguments.length === 1
  ) {
    current = current.arguments[0];
  }
  return Boolean(
    current?.type === "ObjectExpression" && current.properties.length > 0
  );
}
export function isMutatedObjectBinding(declaredBinding) {
  for (const reference of declaredBinding.references) {
    if (!reference.init && reference.isWrite()) {
      return true;
    }
    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (parent?.type === "MemberExpression" && parent.object === identifier) {
      const grandparent = parent.parent;
      if (
        (grandparent?.type === "AssignmentExpression" &&
          grandparent.left === parent) ||
        (grandparent?.type === "UpdateExpression" &&
          grandparent.argument === parent) ||
        (grandparent?.type === "UnaryExpression" &&
          grandparent.operator === "delete" &&
          grandparent.argument === parent)
      ) {
        return true;
      }
    }
    if (
      parent?.type === "CallExpression" &&
      parent.arguments[0] === identifier &&
      parent.callee.type === "MemberExpression" &&
      !parent.callee.computed &&
      parent.callee.object.type === "Identifier" &&
      parent.callee.object.name === "Object" &&
      parent.callee.property.type === "Identifier" &&
      parent.callee.property.name === "assign"
    ) {
      return true;
    }
  }
  return false;
}
export function isKnownEvidenceExpression(expression) {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  if (current.type === "ObjectExpression") return true;
  return (
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}
