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
        if (BUILT_INS.has(specifier.local.name)) {
          shadowedBuiltIns.add(specifier.local.name);
        }
      }
      continue;
    }
    if (declaration?.type === "TSTypeAliasDeclaration") {
      const existing = aliases.get(declaration.id.name);
      if (existing === undefined) aliases.set(declaration.id.name, declaration);
      else shadowedBuiltIns.add(declaration.id.name);
      if (BUILT_INS.has(declaration.id.name)) {
        shadowedBuiltIns.add(declaration.id.name);
      }
      continue;
    }
    if (
      declaration?.type === "TSInterfaceDeclaration" ||
      declaration?.type === "TSEnumDeclaration"
    ) {
      if (BUILT_INS.has(declaration.id.name)) {
        shadowedBuiltIns.add(declaration.id.name);
      }
      continue;
    }
    if (
      (declaration?.type === "ClassDeclaration" ||
        declaration?.type === "FunctionDeclaration") &&
      declaration.id !== null &&
      BUILT_INS.has(declaration.id.name)
    ) {
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
  const nextResolving = new Set(resolving).add(name);
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

function dictionaryReferenceTypes(unwrapped, state) {
  const { environment, substitutions, resolvingAliases } = state;
  const name = typeReferenceName(unwrapped);
  if (name === null) return [];
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValueTypes(substitution, state);
  }
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined ? [] : dictionaryValueTypes(wrapped, state);
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    const recordEntryType = unwrapped.typeArguments?.params[1] ?? null;
    return recordEntryType === null
      ? []
      : [{ type: recordEntryType, substitutions }];
  }
  if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
    const source = unwrapped.typeArguments?.params[0];
    return source === undefined ? [] : dictionaryValueTypes(source, state);
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return [];
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return [];
  return dictionaryValueTypes(alias.typeAnnotation, {
    environment,
    substitutions: nextSubstitutions,
    resolvingAliases: new Set(resolvingAliases).add(name),
  });
}

function dictionaryValueTypes(type, state) {
  const { substitutions } = state;
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
  return unwrapped.type === "TSTypeReference"
    ? dictionaryReferenceTypes(unwrapped, state)
    : [];
}

function resolvesToDictionary(type, state) {
  return dictionaryValueTypes(type, state).length > 0;
}

function classifyReferenceWidening(unwrapped, environment) {
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyWideningTarget(wrapped, environment);
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    return hasBroadRecordKey(unwrapped, {
      environment,
      substitutions: new Map(),
    })
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined) return null;
  const substitutions = aliasSubstitution(alias, unwrapped, new Map());
  if (substitutions === null) return null;
  const state = {
    environment,
    substitutions,
    resolvingAliases: new Set([name]),
  };
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    return resolvesToDictionary(alias.typeAnnotation, state)
      ? { kind: "generic container" }
      : null;
  }
  return classifyAliasBroadTarget(alias.typeAnnotation, state);
}

export function classifyWideningTarget(type, environment) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    if (
      unwrapped.members.some((member) => member.type === "TSIndexSignature")
    ) {
      return { kind: "open dictionary" };
    }
    return unwrapped.members.length > 0 ? { kind: "anonymous object" } : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(unwrapped.constraint, {
      environment,
      substitutions: new Map(),
      resolvingAliases: new Set(),
    })
      ? { kind: "open dictionary" }
      : null;
  }
  return unwrapped.type === "TSTypeReference"
    ? classifyReferenceWidening(unwrapped, environment)
    : null;
}

function hasBroadRecordKey(type, state) {
  const key = type.typeArguments?.params[0];
  return key === undefined
    ? false
    : isBroadMappedKey(key, {
        ...state,
        resolvingAliases: state.resolvingAliases ?? new Set(),
      });
}

function isBroadMappedKey(type, state) {
  if (type === null || type === undefined) return false;
  const { environment, substitutions, resolvingAliases } = state;
  const unwrapped = unwrapTransparentType(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every((member) => isBroadMappedKey(member, state));
  }
  if (unwrapped.type !== "TSTypeReference") return false;
  const name = typeReferenceName(unwrapped);
  if (name === null) return false;
  const substitution = substitutions.get(name);
  if (
    substitution !== undefined &&
    !isUnappliedReferenceTo(substitution, name)
  ) {
    return isBroadMappedKey(substitution, state);
  }
  if (name === "PropertyKey" && isBuiltIn(name, environment)) {
    return true;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return false;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  return (
    nextSubstitutions !== null &&
    isBroadMappedKey(alias.typeAnnotation, {
      environment,
      substitutions: nextSubstitutions,
      resolvingAliases: new Set(resolvingAliases).add(name),
    })
  );
}

function classifyAliasReferenceTarget(unwrapped, state) {
  const { environment, substitutions, resolvingAliases } = state;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : classifyAliasBroadTarget(substitution, state);
  }
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyAliasBroadTarget(wrapped, state);
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    return hasBroadRecordKey(unwrapped, state)
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  return nextSubstitutions === null
    ? null
    : classifyAliasBroadTarget(alias.typeAnnotation, {
        environment,
        substitutions: nextSubstitutions,
        resolvingAliases: new Set(resolvingAliases).add(name),
      });
}

function classifyAliasBroadTarget(type, state) {
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
    return isBroadMappedKey(unwrapped.constraint, state)
      ? { kind: "open dictionary" }
      : null;
  }
  return unwrapped.type === "TSTypeReference"
    ? classifyAliasReferenceTarget(unwrapped, state)
    : null;
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

function isMutatedMemberTarget(member) {
  const outer = member.parent;
  return (
    (outer?.type === "AssignmentExpression" && outer.left === member) ||
    (outer?.type === "UpdateExpression" && outer.argument === member) ||
    (outer?.type === "UnaryExpression" &&
      outer.operator === "delete" &&
      outer.argument === member)
  );
}

export function isMutatedObjectBinding(declaredBinding) {
  for (const reference of declaredBinding.references) {
    if (!reference.init && reference.isWrite()) {
      return true;
    }
    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (
      parent?.type === "MemberExpression" &&
      parent.object === identifier &&
      isMutatedMemberTarget(parent)
    ) {
      return true;
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
