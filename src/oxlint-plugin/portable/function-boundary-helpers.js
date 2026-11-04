import { findDescendant } from "./ast.js";
import { hasRuntimeSchemaProvenance } from "../shared/runtime-schema-libraries.js";
import {
  constInitializer,
  findVariable,
  isFunctionLike,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";
import {
  getResolvedType,
  getTypeServices,
  resolvedDeclarationFiles,
} from "../shared/type-services.js";

const OUTCOME_KEYS = new Set(["kind", "outcome", "status", "type", "ok"]);
const REMAP_EXIT_TYPES = new Set([
  "ObjectExpression",
  "CallExpression",
  "NewExpression",
]);
const TYPE_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const MUTATOR_NAME =
  /^(?:apply|mutate|populate|write|fill|register|install|set|update|append|push|record)(?:[A-Z_\d]|$)/u;
const MUTABLE_HOST_TYPE =
  /^(?:Headers|URLSearchParams|FormData|Set|WeakSet|Element|Node|Document|Window|(?:HTML|SVG)\w*Element|\w*Stream|\w*Writer)$/u;
const EXEMPT_MUTATION_PARAM =
  /^(?:cache|ctx|context|memo|acc|accumulator|out|draft|state|req|res)$/iu;

function returnedCall(body) {
  if (!body) return null;
  let expr = null;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1 || body.body[0].type !== "ReturnStatement") {
      return null;
    }
    expr = unwrapExpression(body.body[0].argument);
  } else {
    expr = unwrapExpression(body);
  }
  return expr?.type === "AwaitExpression"
    ? unwrapExpression(expr.argument)
    : expr;
}

export function functionBinding(node) {
  const parent = node.parent;
  const declaratorName =
    parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier"
      ? parent.id.name
      : null;
  const name = node.id?.name ?? declaratorName;
  if (!name) return null;
  const exported =
    parent?.type === "ExportNamedDeclaration" ||
    parent?.type === "ExportDefaultDeclaration" ||
    parent?.parent?.parent?.type === "ExportNamedDeclaration";
  return { name, exported };
}

function hasValueReturn(body) {
  return (
    findDescendant(
      body,
      (candidate) =>
        candidate.type === "ReturnStatement" && candidate.argument !== null,
      (candidate) => !isFunctionLike(candidate)
    ) !== null
  );
}

export function isLocalFunctionBinding(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  if (definition?.type === "ImportBinding") {
    const source = definition.parent?.source?.value;
    if (
      typeof source === "string" &&
      (source.startsWith(".") ||
        source.startsWith("@/") ||
        source.startsWith("~/"))
    ) {
      return true;
    }
    const files = resolvedDeclarationFiles(identifier, sourceCode);
    return (
      files.length > 0 && files.every((file) => !file.includes("node_modules"))
    );
  }
  return (
    isFunctionLike(definition?.node) ||
    isFunctionLike(unwrapExpression(definition?.node?.init))
  );
}

function localFunctionArity(identifier, sourceCode) {
  const node = findVariable(sourceCode, identifier)?.defs?.[0]?.node;
  const declaration = isFunctionLike(node)
    ? node
    : unwrapExpression(node?.init);
  return isFunctionLike(declaration) ? declaration.params.length : null;
}

const BUILTIN_CALL_OBJECTS = new Set([
  "JSON",
  "Math",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Date",
  "Promise",
  "Reflect",
  "Intl",
  "console",
]);

function isConstantCallArgument(arg) {
  const expr = unwrapExpression(arg);
  if (!expr) return false;
  if (expr.type === "Literal") return true;
  if (expr.type === "ObjectExpression") {
    return expr.properties.every(
      (prop) =>
        prop.type === "Property" &&
        !prop.computed &&
        isConstantCallArgument(prop.value)
    );
  }
  if (expr.type === "ArrayExpression") {
    return expr.elements.every(
      (element) => element && isConstantCallArgument(element)
    );
  }
  return false;
}

function forwardsParameters(call, forwarded, exported) {
  if (forwarded.length === 0) {
    if (call.arguments.length === 0) return true;
    return Boolean(exported) && call.arguments.every(isConstantCallArgument);
  }
  return (
    call.arguments.length === forwarded.length &&
    forwarded.every(
      (parameter, index) =>
        call.arguments[index]?.type === "Identifier" &&
        call.arguments[index].name === parameter.name
    )
  );
}

function isModuleLevel(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) return false;
  }
  return true;
}

function forwardableCallee(node, call, binding, sourceCode) {
  const callee = unwrapExpression(call.callee);
  if (callee?.type === "Identifier") {
    if (node.params.length > 0) return callee;
    if (binding?.exported && call.arguments.length > 0) return callee;
    return isModuleLevel(node) &&
      isLocalFunctionBinding(callee, sourceCode) &&
      localFunctionArity(callee, sourceCode) === 0
      ? callee
      : null;
  }
  const objectIdent =
    callee?.type === "MemberExpression" && callee.object?.type === "Identifier"
      ? callee.object.name
      : null;
  return callee?.type === "MemberExpression" &&
    !callee.computed &&
    node.params.length > 0 &&
    !BUILTIN_CALL_OBJECTS.has(objectIdent) &&
    !hasRuntimeSchemaProvenance(callee.object, sourceCode)
    ? callee
    : null;
}

export function wrapperCandidate(node, sourceCode) {
  if (node.generator) return null;
  if (node.params.some((parameter) => parameter.type !== "Identifier")) {
    return null;
  }
  const binding = functionBinding(node);
  const call = binding ? returnedCall(node.body) : null;
  if (
    call?.type !== "CallExpression" ||
    !forwardsParameters(call, node.params, binding?.exported)
  ) {
    return null;
  }
  const callee = forwardableCallee(node, call, binding, sourceCode);
  if (!callee) return null;
  const isFirstPartyParamWrapper =
    node.params.length > 0 &&
    callee.type === "Identifier" &&
    isLocalFunctionBinding(callee, sourceCode);
  return {
    node: node.id ?? node,
    ...binding,
    callee: sourceCode.getText(callee),
    isFirstPartyParamWrapper,
  };
}

function outcomeMember(expression, bindingName) {
  const member = unwrapExpression(expression);
  return member?.type === "MemberExpression" &&
    unwrapExpression(member.object)?.type === "Identifier" &&
    unwrapExpression(member.object).name === bindingName &&
    OUTCOME_KEYS.has(staticPropertyName(member))
    ? member
    : null;
}

function isOutcomeTest(test, bindingName) {
  const expression = unwrapExpression(test);
  if (
    expression?.type !== "BinaryExpression" ||
    (expression.operator !== "===" && expression.operator !== "==")
  ) {
    return false;
  }
  const [member, literal] =
    expression.left.type === "Literal"
      ? [expression.right, expression.left]
      : [expression.left, expression.right];
  return (
    literal?.type === "Literal" && outcomeMember(member, bindingName) !== null
  );
}

function isRemapExit(statement) {
  const exit =
    statement?.type === "BlockStatement" && statement.body.length === 1
      ? statement.body[0]
      : statement;
  if (exit?.type === "ThrowStatement") return true;
  return (
    exit?.type === "ReturnStatement" &&
    REMAP_EXIT_TYPES.has(unwrapExpression(exit.argument)?.type)
  );
}

function statementArms(statement, bindingName) {
  if (statement.type === "SwitchStatement") {
    if (!outcomeMember(statement.discriminant, bindingName)) return null;
    return statement.cases
      .filter((switchCase) => switchCase.consequent.length > 0)
      .map((switchCase) => ({
        exit:
          switchCase.consequent.length === 1 ? switchCase.consequent[0] : null,
        tested: switchCase.test !== null,
      }));
  }
  if (statement.type !== "IfStatement") return null;
  const arms = [];
  let current = statement;
  for (; current?.type === "IfStatement"; current = current.alternate) {
    arms.push({
      exit: current.consequent,
      tested: isOutcomeTest(current.test, bindingName),
    });
  }
  if (current) arms.push({ exit: current, tested: false });
  return arms;
}

function translationBranchCount(statements, bindingName) {
  let count = 0;
  for (const statement of statements) {
    if (statement.type === "ReturnStatement") continue;
    if (statement.type === "ThrowStatement") continue;
    const arms = statementArms(statement, bindingName);
    if (!arms?.every((arm) => isRemapExit(arm.exit))) return 0;
    count += arms.filter((arm) => arm.tested).length;
  }
  return count;
}

export function outcomeTranslation(node, sourceCode) {
  const binding = functionBinding(node);
  const statements = node.body?.type === "BlockStatement" ? node.body.body : [];
  const [first, ...rest] = statements;
  const declarator =
    first?.type === "VariableDeclaration" && first.declarations.length === 1
      ? first.declarations[0]
      : null;
  const call = unwrapExpression(
    declarator?.init?.type === "AwaitExpression"
      ? declarator.init.argument
      : declarator?.init
  );
  if (
    !binding ||
    declarator?.id?.type !== "Identifier" ||
    call?.type !== "CallExpression" ||
    rest.length === 0
  ) {
    return null;
  }
  const count = translationBranchCount(rest, declarator.id.name);
  return count >= 2
    ? {
        name: binding.name,
        callee: sourceCode.getText(call.callee),
        count: String(count),
      }
    : null;
}

function typeReferenceName(parameter) {
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  return annotation?.type === "TSTypeReference" &&
    annotation.typeName?.type === "Identifier"
    ? annotation.typeName.name
    : "";
}

function mutationSite(reference, isMap) {
  const member = reference.identifier?.parent;
  if (
    member?.type !== "MemberExpression" ||
    member.object !== reference.identifier
  ) {
    return null;
  }
  const site = member.parent;
  if (
    (site?.type === "AssignmentExpression" && site.left === member) ||
    (site?.type === "UpdateExpression" && site.argument === member)
  ) {
    return site;
  }
  return isMap &&
    site?.type === "CallExpression" &&
    site.callee === member &&
    staticPropertyName(member) === "set"
    ? site
    : null;
}

export function argumentMutations(node, sourceCode) {
  const name = functionBinding(node)?.name ?? "";
  if (
    node.body?.type !== "BlockStatement" ||
    hasValueReturn(node.body) ||
    MUTATOR_NAME.test(name)
  ) {
    return [];
  }
  const mutations = [];
  for (const parameter of node.params) {
    const typeName = typeReferenceName(parameter);
    if (
      parameter.type !== "Identifier" ||
      EXEMPT_MUTATION_PARAM.test(parameter.name) ||
      MUTABLE_HOST_TYPE.test(typeName)
    ) {
      continue;
    }
    const references = findVariable(sourceCode, parameter)?.references ?? [];
    const site = references
      .map((reference) => mutationSite(reference, typeName === "Map"))
      .find(Boolean);
    if (site) mutations.push({ node: site, name: parameter.name });
  }
  return mutations;
}

function exitsEarly(statement) {
  if (statement?.type === "BlockStatement") {
    return exitsEarly(statement.body.at(-1));
  }
  return (
    statement?.type === "ReturnStatement" ||
    statement?.type === "ThrowStatement"
  );
}

function resolvedStringCollection(identifier, sourceCode) {
  const services = getTypeServices(sourceCode);
  const type = services && getResolvedType(identifier, sourceCode);
  if (!type) return null;
  const typeArgs = services.checker.getTypeArguments?.(type) ?? [];
  const elementType =
    typeArgs[0] ?? services.checker.getNumberIndexType?.(type);
  let parts = typeArgs;
  if (elementType?.isUnion?.()) {
    parts = elementType.types;
  } else if (elementType) {
    parts = [elementType];
  }
  if (parts.length < 2) return null;
  const literals = [];
  for (const part of parts) {
    if (!part?.isStringLiteral?.() || typeof part.value !== "string") {
      return null;
    }
    literals.push(`"${part.value}"`);
  }
  return [...new Set(literals)];
}

function constStringCollection(identifier, sourceCode) {
  const init = unwrapExpression(constInitializer(sourceCode, identifier));
  if (!init) return resolvedStringCollection(identifier, sourceCode);
  const elements =
    init?.type === "NewExpression" && init.callee?.name === "Set"
      ? unwrapExpression(init.arguments[0])?.elements
      : init?.type === "ArrayExpression" && init.elements;
  const literals = (elements || []).map((element) =>
    element?.type === "Literal" && typeof element.value === "string"
      ? `"${element.value}"`
      : null
  );
  return literals.length > 0 && literals.every(Boolean) ? literals : null;
}

function guardLiterals(reference, sourceCode) {
  let argument = reference.identifier;
  while (TYPE_WRAPPERS.has(argument.parent?.type)) argument = argument.parent;
  const call = argument.parent;
  const callee = call?.callee;
  if (
    call?.type !== "CallExpression" ||
    call.arguments[0] !== argument ||
    callee?.type !== "MemberExpression" ||
    !["includes", "has"].includes(staticPropertyName(callee)) ||
    callee.object?.type !== "Identifier"
  ) {
    return null;
  }
  const negation = call.parent;
  const guard = negation?.parent;
  return negation?.type === "UnaryExpression" &&
    negation.operator === "!" &&
    guard?.type === "IfStatement" &&
    guard.test === negation &&
    exitsEarly(guard.consequent)
    ? constStringCollection(callee.object, sourceCode)
    : null;
}

export function closedCollectionGuard(binding, sourceCode) {
  for (const reference of binding.references) {
    const literals = guardLiterals(reference, sourceCode);
    if (literals) return literals;
  }
  return null;
}

function isOnlyBranchSelector(parameter, body, sourceCode) {
  const references = findVariable(sourceCode, parameter)?.references ?? [];
  if (references.length !== 1) return false;
  let test = references[0].identifier;
  if (test.parent?.type === "UnaryExpression" && test.parent.operator === "!") {
    test = test.parent;
  }
  const statement = test.parent;
  return (
    statement?.type === "IfStatement" &&
    statement.test === test &&
    (statement.alternate !== null ||
      (exitsEarly(statement.consequent) && body.body.length >= 2)) &&
    body.body.includes(statement)
  );
}

export function booleanModeParameter(node, sourceCode) {
  const binding = functionBinding(node);
  if (
    !binding?.exported ||
    node.params.length < 1 ||
    node.body?.type !== "BlockStatement"
  ) {
    return null;
  }
  const parameter = node.params.find(
    (candidate) =>
      candidate.type === "Identifier" &&
      candidate.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword" &&
      isOnlyBranchSelector(candidate, node.body, sourceCode)
  );
  return parameter ? { parameter, functionName: binding.name } : null;
}
