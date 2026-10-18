import ts from "typescript";

import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  identifierName,
  isSyntaxType,
  isSyntaxTypeIn,
  syntaxChildren,
  syntaxField,
  syntaxText,
} from "../kernel/syntax-node.ts";
import { isZodMethod } from "../projection/schema-provenance.ts";
import { callExpressionName } from "./auth-boundary.ts";
import { syntaxDescendants } from "./binding-syntax.ts";
import {
  isAppeasementCastSourceType,
  isBroadPredicateInputType,
} from "./broad-input-type.ts";
import {
  callUsesPredicateParam,
  identifierDeclarator,
  PredicatePaths,
  reflectGetParts,
  staticMemberName,
} from "./predicate-paths.ts";

type TagRead = {
  readonly base: unknown;
  readonly name: string;
};

const UNIT_TYPE_FLAGS =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.EnumLiteral;

const ZOD_VALIDATOR_METHODS = new Set(["parse", "parseAsync", "safeParse"]);
const EQUALITY_OPERATORS = new Set(["===", "==", "!==", "!="]);
const TAG_WRAPPER_TYPES = new Set(["ChainExpression", "TSNonNullExpression"]);
const TYPE_ASSERTION_TYPES = new Set(["TSAsExpression", "TSTypeAssertion"]);

function isUnitType(type: ts.Type): boolean {
  return (
    (type.flags & UNIT_TYPE_FLAGS) !== 0 &&
    (type.flags & ts.TypeFlags.Union) === 0
  );
}

function isDiscriminantType(type: ts.Type): boolean {
  return type.isUnion() ? type.types.every(isUnitType) : isUnitType(type);
}

function propertyTypeAtPath(
  checker: ts.TypeChecker,
  type: ts.Type,
  path: readonly string[]
): ts.Type | null {
  let current = type;
  for (const name of path) {
    const property = checker.getPropertyOfType(
      checker.getNonNullableType(current),
      name
    );
    if (!property) {
      return null;
    }
    current = checker.getTypeOfSymbol(property);
  }
  return checker.getNonNullableType(current);
}

function isTypeAssertion(node: unknown): boolean {
  const target = syntaxField(node, "typeAnnotation");
  return (
    isSyntaxTypeIn(node, TYPE_ASSERTION_TYPES) &&
    !(
      isSyntaxType(target, "TSTypeReference") &&
      identifierName(syntaxField(target, "typeName")) === "const"
    )
  );
}

function containsTypeAssertion(
  expression: unknown,
  assertedNames: ReadonlySet<string>
): boolean {
  for (const current of syntaxDescendants(expression)) {
    const name = identifierName(current);
    if (
      isTypeAssertion(current) ||
      (name !== null && assertedNames.has(name))
    ) {
      return true;
    }
  }
  return false;
}

function tagRead(
  side: unknown,
  aliasInits: ReadonlyMap<string, unknown>
): TagRead | null {
  let node = side;
  while (isSyntaxTypeIn(node, TAG_WRAPPER_TYPES)) {
    node = syntaxField(node, "expression");
  }
  const aliasName = identifierName(node);
  if (aliasName !== null && aliasInits.has(aliasName)) {
    return tagRead(aliasInits.get(aliasName), aliasInits);
  }
  if (isSyntaxType(node, "MemberExpression")) {
    const name = staticMemberName(node);
    return name === null ? null : { base: syntaxField(node, "object"), name };
  }
  const reflected = reflectGetParts(node);
  return reflected && { base: reflected.target, name: reflected.name };
}

function literalOfUnitType(type: ts.Type) {
  if (type.isStringLiteral() || type.isNumberLiteral()) {
    return type.value;
  }
  return (type.flags & ts.TypeFlags.BooleanLiteral) !== 0
    ? type.intrinsicName === "true"
    : undefined;
}

class ContractEvidenceScan {
  readonly checked = new Set<string>();
  proven = false;
  readonly #paths: PredicatePaths;
  readonly #targetType: ts.Type;
  readonly #services: TypeScriptParserServices;
  readonly #checker: ts.TypeChecker;
  readonly #assertedNames = new Set<string>();
  readonly #aliasInits = new Map<string, unknown>();

  constructor(
    paths: PredicatePaths,
    targetType: ts.Type,
    services: TypeScriptParserServices,
    checker: ts.TypeChecker
  ) {
    this.#paths = paths;
    this.#targetType = targetType;
    this.#services = services;
    this.#checker = checker;
  }

  visit(current: unknown): void {
    if (this.proven) {
      return;
    }
    const declarator = identifierDeclarator(current);
    if (declarator) {
      this.#recordDeclarator(declarator.name, declarator.init);
      return;
    }
    if (isSyntaxType(current, "BinaryExpression")) {
      this.proven = this.#comparisonProves(current);
      return;
    }
    if (isSyntaxType(current, "CallExpression")) {
      this.#scanDelegatedCall(current);
    }
  }

  #recordDeclarator(name: string, init: unknown): void {
    if (
      this.#paths.paramNames.has(name) &&
      containsTypeAssertion(init, this.#assertedNames)
    ) {
      this.#assertedNames.add(name);
    }
    if (this.#paths.recordAlias(name, init)) {
      this.#aliasInits.set(name, init);
    }
  }

  #comparisonProves(binary: SyntaxNode): boolean {
    const operator = syntaxField(binary, "operator");
    const left = syntaxField(binary, "left");
    const right = syntaxField(binary, "right");
    if (operator === "instanceof") {
      return this.#instanceofProves(this.#paths.pathOf(left), right);
    }
    return (
      (operator === "===" || operator === "==") &&
      (this.#comparisonSideProves(left, right) ||
        this.#comparisonSideProves(right, left))
    );
  }

  #instanceofProves(
    paramPath: readonly string[] | null,
    constructorNode: unknown
  ): boolean {
    if (paramPath?.length !== 0) {
      return false;
    }
    const tsConstructor =
      this.#services.esTreeNodeToTSNodeMap.get(constructorNode);
    if (!tsConstructor) {
      return false;
    }
    return this.#checker
      .getTypeAtLocation(tsConstructor)
      .getConstructSignatures()
      .some((signature) =>
        this.#checker.isTypeAssignableTo(
          this.#checker.getReturnTypeOfSignature(signature),
          this.#targetType
        )
      );
  }

  #comparisonSideProves(side: unknown, other: unknown): boolean {
    const path = this.#paths.pathOf(side);
    const tsOther = this.#services.esTreeNodeToTSNodeMap.get(other);
    if (!path || !tsOther) {
      return false;
    }
    const tag = tagRead(side, this.#aliasInits);
    return (
      tag !== null &&
      this.#matchesTargetDiscriminant(
        path,
        this.#checker.getTypeAtLocation(tsOther)
      ) &&
      this.#isClosedTagSource(tag.base, tag.name)
    );
  }

  #matchesTargetDiscriminant(
    path: readonly string[],
    valueType: ts.Type
  ): boolean {
    if (path.length === 0 || !isUnitType(valueType)) {
      return false;
    }
    const propertyType = propertyTypeAtPath(
      this.#checker,
      this.#targetType,
      path
    );
    return (
      propertyType !== null &&
      isDiscriminantType(propertyType) &&
      this.#checker.isTypeAssignableTo(valueType, propertyType)
    );
  }

  #isClosedTagSource(base: unknown, name: string): boolean {
    if (containsTypeAssertion(base, this.#assertedNames)) {
      return false;
    }
    const tsBase = this.#services.esTreeNodeToTSNodeMap.get(base);
    if (!tsBase) {
      return false;
    }
    const baseType = this.#checker.getTypeAtLocation(tsBase);
    if (isBroadPredicateInputType(this.#checker, baseType)) {
      return false;
    }
    const tagType = propertyTypeAtPath(this.#checker, baseType, [name]);
    return tagType !== null && isDiscriminantType(tagType);
  }

  #delegatedPredicate(call: SyntaxNode) {
    const tsCall = this.#services.esTreeNodeToTSNodeMap.get(call);
    const signature =
      tsCall && ts.isCallLikeExpression(tsCall)
        ? this.#checker.getResolvedSignature(tsCall)
        : undefined;
    const predicate =
      signature && this.#checker.getTypePredicateOfSignature(signature);
    if (!predicate?.type || isAppeasementCastSourceType(predicate.type)) {
      return null;
    }
    const argument =
      predicate.parameterIndex === undefined
        ? undefined
        : syntaxChildren(call, "arguments")[predicate.parameterIndex];
    return this.#paths.pathOf(argument)?.length === 0
      ? { type: predicate.type, argument }
      : null;
  }

  #scanDelegatedCall(call: SyntaxNode): void {
    const delegated = this.#delegatedPredicate(call);
    if (!delegated) {
      return;
    }
    if (this.#checker.isTypeAssignableTo(delegated.type, this.#targetType)) {
      this.proven = true;
      return;
    }
    for (const property of this.#checker.getPropertiesOfType(delegated.type)) {
      this.checked.add(property.name);
      const propertyType = this.#checker.getNonNullableType(
        this.#checker.getTypeOfSymbol(property)
      );
      if (
        this.#matchesTargetDiscriminant([property.name], propertyType) &&
        this.#isClosedTagSource(delegated.argument, property.name)
      ) {
        this.proven = true;
      }
    }
  }
}

export function predicateContractEvidence(
  node: unknown,
  paramName: string,
  targetType: ts.Type,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
) {
  const scan = new ContractEvidenceScan(
    new PredicatePaths(node, paramName),
    targetType,
    services,
    checker
  );
  for (const current of syntaxDescendants(node)) {
    scan.visit(current);
  }
  return { proven: scan.proven, checked: scan.checked };
}

class TagComparisons {
  readonly #paths: PredicatePaths;
  readonly #services: TypeScriptParserServices;
  readonly #checker: ts.TypeChecker;
  readonly #literalsByField = new Map<string, Set<string | number | boolean>>();

  constructor(
    paths: PredicatePaths,
    services: TypeScriptParserServices,
    checker: ts.TypeChecker
  ) {
    this.#paths = paths;
    this.#services = services;
    this.#checker = checker;
  }

  visit(current: unknown): void {
    const declarator = identifierDeclarator(current);
    if (declarator) {
      this.#paths.recordAlias(declarator.name, declarator.init);
      return;
    }
    const operator = syntaxText(current, "operator");
    if (
      isSyntaxType(current, "BinaryExpression") &&
      operator !== null &&
      EQUALITY_OPERATORS.has(operator)
    ) {
      this.#record(syntaxField(current, "left"), syntaxField(current, "right"));
      this.#record(syntaxField(current, "right"), syntaxField(current, "left"));
      return;
    }
    const discriminant = syntaxField(current, "discriminant");
    const tests = isSyntaxType(current, "SwitchStatement")
      ? syntaxChildren(current, "cases").map((switchCase) =>
          syntaxField(switchCase, "test")
        )
      : [];
    for (const test of tests) {
      if (test) {
        this.#record(discriminant, test);
      }
    }
  }

  accepts(variant: ts.Type): boolean {
    return [...this.#literalsByField].every(([field, fieldLiterals]) => {
      const property = this.#checker.getPropertyOfType(variant, field);
      const tag = property
        ? literalOfUnitType(this.#checker.getTypeOfSymbol(property))
        : undefined;
      return tag === undefined || fieldLiterals.has(tag);
    });
  }

  #record(side: unknown, other: unknown): void {
    const path = this.#paths.pathOf(side);
    const tsOther = this.#services.esTreeNodeToTSNodeMap.get(other);
    const field = path?.length === 1 ? path[0] : undefined;
    if (field === undefined || !tsOther) {
      return;
    }
    const literal = literalOfUnitType(this.#checker.getTypeAtLocation(tsOther));
    if (literal === undefined) {
      return;
    }
    const fieldLiterals = this.#literalsByField.get(field) ?? new Set();
    fieldLiterals.add(literal);
    this.#literalsByField.set(field, fieldLiterals);
  }
}

export function claimedTargetVariants(
  node: unknown,
  paramName: string,
  variants: readonly ts.Type[],
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): ts.Type[] {
  const comparisons = new TagComparisons(
    new PredicatePaths(node, paramName),
    services,
    checker
  );
  for (const current of syntaxDescendants(node)) {
    comparisons.visit(current);
  }
  return variants.filter((variant) => comparisons.accepts(variant));
}

export function hasValidatorDelegation(
  node: unknown,
  paramName: string,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker
): boolean {
  for (const current of syntaxDescendants(node)) {
    if (
      !isSyntaxType(current, "CallExpression") ||
      !callUsesPredicateParam(current, paramName)
    ) {
      continue;
    }
    const callee = syntaxField(current, "callee");
    const methodName = callExpressionName(callee);
    const tsCall = services.esTreeNodeToTSNodeMap.get(current);
    const tsMethodName =
      tsCall &&
      ts.isCallExpression(tsCall) &&
      ts.isPropertyAccessExpression(tsCall.expression)
        ? tsCall.expression.name
        : undefined;
    if (
      isSyntaxType(callee, "MemberExpression") &&
      !syntaxField(callee, "computed") &&
      methodName !== null &&
      ZOD_VALIDATOR_METHODS.has(methodName) &&
      isZodMethod(checker, tsMethodName)
    ) {
      return true;
    }
  }
  return false;
}
