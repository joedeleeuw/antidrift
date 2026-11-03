import { checkUndecodedCast } from "./boundary-decode-checks.js";
import {
  hasTypeChecker,
  resolvedDeclarationFiles,
  resolvedPropertyShape,
  resolvedTypeTexts,
} from "../shared/type-services.js";
import {
  findVariable,
  isFunctionLike,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const NULLISH_REMOVALS = {
  "!== null": ["null"],
  "!== undefined": ["undefined"],
  "!= null": ["null", "undefined"],
  "!= undefined": ["null", "undefined"],
};
const VALIDATOR_METHODS =
  /^(?:parse|safeParse|parseAsync|safeParseAsync|is|assert|Check|decode\w*)$/u;
const BROAD_PARAMETER_TYPES = new Set([
  "TSUnknownKeyword",
  "TSAnyKeyword",
  "TSObjectKeyword",
]);

export function forEachOwnNode(root, sourceCode, visit) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current.type !== "string") continue;
    visit(current);
    if (current === root || !isFunctionLike(current)) {
      for (const key of sourceCode.visitorKeys[current.type] ?? []) {
        pending.push(...[current[key]].flat());
      }
    }
  }
}

export function topLevelTypeDeclarations(program) {
  const declarations = new Map();
  for (const stmt of program.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (
      (decl?.type === "TSInterfaceDeclaration" ||
        decl?.type === "TSTypeAliasDeclaration") &&
      decl.id?.name
    ) {
      declarations.set(decl.id.name, decl);
    }
  }
  return declarations;
}

function predicateParts(node) {
  const predicate = node.returnType?.typeAnnotation;
  const paramName =
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName?.type === "Identifier"
      ? predicate.parameterName.name
      : null;
  const parameter = node.params.find(
    (candidate) =>
      candidate.type === "Identifier" && candidate.name === paramName
  );
  const target = predicate?.typeAnnotation?.typeAnnotation;
  return parameter && target
    ? { predicate, parameter, paramName, target }
    : null;
}

export function singleReturnExpression(body) {
  if (body?.type !== "BlockStatement") return unwrapExpression(body);
  const [only] = body.body;
  return body.body.length === 1 && only.type === "ReturnStatement"
    ? unwrapExpression(only.argument)
    : null;
}

function nullishRemoval(test, paramName) {
  if (test?.type !== "BinaryExpression") return null;
  const subjectLeft =
    test.left.type === "Identifier" && test.left.name === paramName;
  const subject = subjectLeft ? test.left : test.right;
  const other = subjectLeft ? test.right : test.left;
  const otherText =
    other.raw === "null" || other.name === "undefined"
      ? (other.raw ?? other.name)
      : "";
  return subject.type === "Identifier" && subject.name === paramName
    ? (NULLISH_REMOVALS[`${test.operator} ${otherText}`] ?? null)
    : null;
}

function constituentTexts(typeNode, sourceCode) {
  const members = typeNode.type === "TSUnionType" ? typeNode.types : [typeNode];
  return members.map((member) => sourceCode.getText(member));
}

function narrowedMatchesTarget(parts, removed, sourceCode) {
  const annotation = parts.parameter.typeAnnotation?.typeAnnotation;
  const declared = annotation
    ? constituentTexts(annotation, sourceCode)
    : resolvedTypeTexts(parts.parameter, sourceCode);
  const targets = annotation
    ? constituentTexts(parts.target, sourceCode)
    : resolvedTypeTexts(parts.target, sourceCode);
  if (
    !declared ||
    !targets ||
    !declared.some((text) => removed.includes(text))
  ) {
    return false;
  }
  const narrowed = declared.filter((text) => !removed.includes(text));
  return (
    narrowed.length === targets.length &&
    narrowed.every((text) => targets.includes(text))
  );
}

function checkCallbackPredicate(node, parts, context) {
  const sourceCode = context.sourceCode;
  const test = singleReturnExpression(node.body);
  const removed = nullishRemoval(test, parts.paramName);
  if (
    node.async ||
    node.generator ||
    !removed ||
    !node.parent?.arguments?.includes(node) ||
    (!parts.parameter.typeAnnotation && !hasTypeChecker(sourceCode)) ||
    !narrowedMatchesTarget(parts, removed, sourceCode)
  ) {
    return;
  }
  context.report({
    node: parts.predicate,
    message: `Type predicate '${parts.paramName} is ${sourceCode.getText(parts.target)}' restates what TypeScript infers from '${sourceCode.getText(test)}'; drop the annotation.`,
  });
}

function rootName(member) {
  let current = member;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" ? current.name : null;
}

function conjunctionComparisons(expression, paramName, sourceCode) {
  const node = unwrapExpression(expression);
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    return [node.left, node.right].flatMap((side) =>
      conjunctionComparisons(side, paramName, sourceCode)
    );
  }
  if (node?.type !== "BinaryExpression" || !/^[!=]==$/u.test(node.operator)) {
    return [];
  }
  const member = node.left.type === "MemberExpression" ? node.left : node.right;
  const literal = member === node.left ? node.right : node.left;
  return rootName(member) === paramName && typeof literal.value === "string"
    ? [{ path: sourceCode.getText(member), literal: literal.value }]
    : [];
}

function checkConflatedPredicate(node, parts, context) {
  const sourceCode = context.sourceCode;
  const root = parts.parameter.typeAnnotation?.typeAnnotation;
  const typeArgument = parts.target.typeArguments?.params?.[0];
  const literal = typeArgument?.literal?.value;
  if (
    root?.type !== "TSTypeReference" ||
    root.typeArguments ||
    parts.target.type !== "TSTypeReference" ||
    typeArgument?.type !== "TSLiteralType" ||
    typeof literal !== "string"
  ) {
    return;
  }
  const comparisons = conjunctionComparisons(
    singleReturnExpression(node.body),
    parts.paramName,
    sourceCode
  );
  const paths = new Set(comparisons.map((comparison) => comparison.path));
  if (
    paths.size >= 2 &&
    comparisons.some((comparison) => comparison.literal === literal)
  ) {
    const rootText = sourceCode.getText(root.typeName);
    const targetText = sourceCode.getText(parts.target.typeName);
    context.report({
      node,
      message: `Type predicate conflates root discriminator '${literal}' with facet narrowing; parameterize the predicate as <K>(${parts.paramName}: ${rootText}<K>): ${parts.paramName} is ${targetText}<K>.`,
    });
  }
}

export function checkRedundantPredicate(node, context) {
  const sourceCode = context.sourceCode;
  const parts = predicateParts(node);
  if (!parts || parts.predicate.asserts) return;
  const paramType = parts.parameter.typeAnnotation?.typeAnnotation;
  if (
    paramType &&
    sourceCode.getText(paramType) === sourceCode.getText(parts.target)
  ) {
    context.report({
      node: parts.predicate,
      message: `Type predicate '${parts.paramName} is ${sourceCode.getText(parts.target)}' is redundant because '${parts.paramName}' is already typed as '${sourceCode.getText(paramType)}'.`,
    });
    return;
  }
  checkCallbackPredicate(node, parts, context);
  checkConflatedPredicate(node, parts, context);
}

function extractRequiredFields(members) {
  return (members ?? [])
    .filter(
      (member) =>
        member.type === "TSPropertySignature" &&
        !member.optional &&
        member.key?.type === "Identifier"
    )
    .map((member) => member.key.name);
}

function targetContract(target, typeFields, sourceCode) {
  const name =
    target.type === "TSTypeReference" && target.typeName?.type === "Identifier"
      ? target.typeName.name
      : null;
  if (typeFields.has(name)) {
    return { name, required: typeFields.get(name) };
  }
  if (target.type === "TSTypeLiteral") {
    return {
      name: sourceCode.getText(target),
      required: extractRequiredFields(target.members),
    };
  }
  if (
    target.type !== "TSTypeReference" ||
    !hasTypeChecker(sourceCode) ||
    resolvedDeclarationFiles(target, sourceCode).some((file) =>
      file.includes("/node_modules/")
    )
  ) {
    return null;
  }
  const shape = resolvedPropertyShape(target, sourceCode);
  return shape
    ? { name: sourceCode.getText(target), required: shape.required }
    : null;
}

function collectAliases(body, subjects, sourceCode) {
  forEachOwnNode(body, sourceCode, (node) => {
    const init = unwrapExpression(node.init);
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      init?.type === "Identifier" &&
      subjects.has(findVariable(sourceCode, init))
    ) {
      subjects.add(findVariable(sourceCode, node.id));
    }
  });
}

const FIELD_EVIDENCE = {
  MemberExpression: (node, isSubject) =>
    isSubject(node.object)
      ? { fields: [staticPropertyName(node)] }
      : {
          delegated:
            node.object?.name === "Symbol" &&
            staticPropertyName(node) === "for",
        },
  BinaryExpression: (node, isSubject) =>
    node.operator === "in" && isSubject(node.right)
      ? { fields: [node.left.value] }
      : { delegated: node.operator === "instanceof" && isSubject(node.left) },
  VariableDeclarator: (node, isSubject) => ({
    fields: isSubject(node.init)
      ? (node.id.properties ?? []).map(
          (property) => property.key?.name ?? property.key?.value
        )
      : [],
  }),
  CallExpression: (node, isSubject) =>
    node.arguments.some(isSubject)
      ? {
          fields: node.arguments.map((argument) => argument.value),
          delegated: VALIDATOR_METHODS.test(
            staticPropertyName(unwrapExpression(node.callee))
          ),
        }
      : {},
};

function fieldEvidence(fnNode, parameter, sourceCode) {
  const subjects = new Set([findVariable(sourceCode, parameter)]);
  collectAliases(fnNode.body, subjects, sourceCode);
  const isSubject = (candidate) => {
    const identifier = unwrapExpression(candidate);
    return (
      identifier?.type === "Identifier" &&
      subjects.has(findVariable(sourceCode, identifier))
    );
  };
  const fields = new Set();
  let delegated = false;
  forEachOwnNode(fnNode.body, sourceCode, (node) => {
    const evidence = FIELD_EVIDENCE[node.type]?.(node, isSubject) ?? {};
    for (const field of evidence.fields ?? []) fields.add(field);
    delegated ||= Boolean(evidence.delegated);
  });
  return { fields, delegated };
}

function checkUndercheckedPredicate(node, typeFields, context) {
  const sourceCode = context.sourceCode;
  const parts = predicateParts(node);
  const paramType = parts?.parameter.typeAnnotation?.typeAnnotation;
  if (
    !BROAD_PARAMETER_TYPES.has(paramType?.type) &&
    !(
      paramType?.type === "TSTypeReference" &&
      paramType.typeName?.name === "Record"
    )
  ) {
    return;
  }
  const contract = targetContract(parts.target, typeFields, sourceCode);
  if (!contract || contract.required.length < 2) return;
  const evidence = fieldEvidence(node, parts.parameter, sourceCode);
  const checkedCount = contract.required.filter((field) =>
    evidence.fields.has(field)
  ).length;
  if (!evidence.delegated && checkedCount < contract.required.length) {
    context.report({
      node: parts.predicate,
      message: `Type predicate for '${contract.name}' only checks ${checkedCount}/${contract.required.length} required fields on an '${sourceCode.getText(paramType)}' value; validate the full contract or use a schema decoder.`,
    });
  }
}

export function checkTypeAssertion(node, context) {
  const target = node.typeAnnotation;
  if (target?.type === "TSAnyKeyword") {
    context.report({
      node,
      message:
        "Do not cast to `any`; decode untrusted values at the boundary or use a narrow type.",
    });
    return;
  }
  const inner = node.expression;
  if (
    (inner?.type === "TSAsExpression" || inner?.type === "TSTypeAssertion") &&
    inner.typeAnnotation?.type !== "TSTypeReference"
  ) {
    context.report({
      node,
      message:
        "Do not chain type assertions (`as unknown as T`); fix the type contract or decode at the boundary.",
    });
    return;
  }
  if (
    inner?.type === "ObjectExpression" &&
    target?.type === "TSTypeReference" &&
    !(
      target.typeName?.type === "Identifier" && target.typeName.name === "const"
    )
  ) {
    context.report({
      node,
      message:
        "Do not cast an object literal with `as T`; use `satisfies T` or a variable type annotation so missing fields fail typechecking.",
    });
    return;
  }
  checkUndecodedCast(node, context);
}

export function createUndercheckedPredicateVisitors(context) {
  const typeFields = new Map();
  const checkFunction = (node) =>
    checkUndercheckedPredicate(node, typeFields, context);
  return {
    Program(node) {
      for (const [name, decl] of topLevelTypeDeclarations(node)) {
        const members = decl.body?.body ?? decl.typeAnnotation?.members;
        if (members) typeFields.set(name, extractRequiredFields(members));
      }
    },
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
  };
}
