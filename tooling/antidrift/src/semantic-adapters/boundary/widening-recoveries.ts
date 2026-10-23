import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";
import {
  EQUALITY_OPERATOR_KINDS,
  isAssignmentTarget,
  isNullishLiteral,
  memberKeyText,
  skipOuterParents,
} from "./narrowing-syntax.ts";
import { RecoveryTests } from "./widening-tests.ts";
import type { RecoveryTest } from "./widening-tests.ts";

type RecoveryKind =
  | "assertion"
  | "predicate"
  | "typeof"
  | "in"
  | "instanceof"
  | "discriminant"
  | "forwarding";

/** What the caller knows about an operand before any type work: whether it derives from a slot, and what that slot declares there. */
export type OperandRelevance = {
  readonly traces: (operand: ts.Expression) => boolean;
  readonly declaresAny: (operand: ts.Expression) => boolean;
  readonly declaresUnion: (operand: ts.Expression) => boolean;
};

const IRRELEVANT: OperandRelevance = {
  traces: () => false,
  declaresAny: () => false,
  declaresUnion: () => false,
};

export type Recovery = {
  readonly kind: RecoveryKind;
  readonly node: ts.Node;
  readonly operand: ts.Expression;
  readonly label: string;
  readonly test: RecoveryTest;
};

const TOP_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

export function skipParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

export function isTopType(type: ts.Type): boolean {
  return (type.flags & TOP_FLAGS) !== 0 && !isErrorType(type);
}

/** The element-yielding callback position of an array method, if any. */
export function arrayCallbackReceiver(
  parameter: ts.ParameterDeclaration
): ts.Expression | null {
  const callback = parameter.parent;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return null;
  }
  const call = callback.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments[0] !== callback ||
    !ts.isPropertyAccessExpression(call.expression)
  ) {
    return null;
  }
  const method = call.expression.name.text;
  const position = callback.parameters.indexOf(parameter);
  const elementPosition = method.startsWith("reduce") ? 1 : 0;
  if (
    position !== elementPosition ||
    !(ARRAY_CALLBACK_METHODS.has(method) || method.startsWith("reduce"))
  ) {
    return null;
  }
  return call.expression.expression;
}

/**
 * `(value as T).key = next`: a cast that only lets a write through adds a
 * member rather than re-deriving one, so it is not a recovery.
 */
function writesThrough(assertion: ts.AssertionExpression): boolean {
  let node: ts.Node = skipOuterParents(assertion);
  let member = false;
  while (
    (ts.isPropertyAccessExpression(node.parent) ||
      ts.isElementAccessExpression(node.parent)) &&
    node.parent.expression === node
  ) {
    node = skipOuterParents(node.parent);
    member = true;
  }
  return (
    member && (isAssignmentTarget(node) || ts.isDeleteExpression(node.parent))
  );
}

/**
 * Whether a call's boolean result decides a branch, or the call stands alone
 * as an assertion: the positions where a type predicate narrows.
 */
function testsCondition(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    (ts.isPrefixUnaryExpression(node.parent) &&
      node.parent.operator === ts.SyntaxKind.ExclamationToken)
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken
    );
  }
  return (
    ts.isExpressionStatement(parent) ||
    (ts.isConditionalExpression(parent) && parent.condition === node) ||
    ((ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)) &&
      parent.expression === node) ||
    (ts.isForStatement(parent) && parent.condition === node)
  );
}

/**
 * Reads the constructs that re-establish a type from a value: assertions,
 * type-predicate and assertion-function calls, `typeof`, `in`, `instanceof`
 * and discriminant checks, and an `any` value forwarded into a slot that
 * demands a narrower type. Nullish checks, non-null assertions and `??`/`||`
 * fallbacks are not recoveries here.
 */
export class RecoveryReader {
  readonly #checker: ts.TypeChecker;
  readonly #tests: RecoveryTests;
  #relevance: OperandRelevance = IRRELEVANT;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
    this.#tests = new RecoveryTests(checker);
  }

  /** The recoveries at `node` whose operand derives from a slot; type work runs only for those. */
  at(node: ts.Node, relevance: OperandRelevance): readonly Recovery[] {
    this.#relevance = relevance;
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return this.#assertion(node);
    }
    if (ts.isCallExpression(node)) {
      return [...this.#predicate(node), ...this.#forwardedArguments(node)];
    }
    if (ts.isBinaryExpression(node)) {
      return [...this.#comparison(node), ...this.#assignment(node)];
    }
    if (ts.isSwitchStatement(node)) {
      return this.#switchCases(node);
    }
    if (ts.isVariableDeclaration(node)) {
      return this.#declaration(node);
    }
    if (ts.isReturnStatement(node)) {
      return this.#returned(node);
    }
    return [];
  }

  #assertion(assertion: ts.AssertionExpression): readonly Recovery[] {
    const { type } = assertion;
    if (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === "const"
    ) {
      return [];
    }
    if (writesThrough(assertion)) {
      return [];
    }
    let operand = skipParentheses(assertion.expression);
    while (
      (ts.isAsExpression(operand) || ts.isTypeAssertionExpression(operand)) &&
      isTopType(this.#checker.getTypeFromTypeNode(operand.type))
    ) {
      operand = skipParentheses(operand.expression);
    }
    if (!this.#relevance.traces(operand)) {
      return [];
    }
    const target = this.#checker.getTypeFromTypeNode(type);
    if (isTopType(target) || isErrorType(target)) {
      return [];
    }
    return [
      {
        kind: "assertion",
        node: assertion,
        operand,
        label: ts.isAsExpression(assertion)
          ? "the `as` cast"
          : "the type assertion",
        test: this.#tests.type(target),
      },
    ];
  }

  #predicate(call: ts.CallExpression): readonly Recovery[] {
    if (
      !testsCondition(call) ||
      !call.arguments.some(
        (argument) =>
          !ts.isSpreadElement(argument) && this.#relevance.traces(argument)
      )
    ) {
      return [];
    }
    const checker = this.#checker;
    const signature = checker.getResolvedSignature(call);
    const predicate =
      signature && checker.getTypePredicateOfSignature(signature);
    if (
      !predicate?.type ||
      (predicate.kind !== ts.TypePredicateKind.Identifier &&
        predicate.kind !== ts.TypePredicateKind.AssertsIdentifier)
    ) {
      return [];
    }
    const operand = call.arguments[predicate.parameterIndex];
    if (!operand || ts.isSpreadElement(operand)) {
      return [];
    }
    const callee = skipParentheses(call.expression);
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : callee.getText();
    const role =
      predicate.kind === ts.TypePredicateKind.Identifier
        ? "guard"
        : "assertion";
    return [
      {
        kind: "predicate",
        node: call,
        operand,
        label: `the \`${name}\` ${role}`,
        test: this.#tests.type(predicate.type),
      },
    ];
  }

  #forwarded(
    node: ts.Node,
    operand: ts.Expression | undefined,
    demandedType: () => ts.Type | undefined,
    label: string
  ): readonly Recovery[] {
    if (!operand || !this.#relevance.declaresAny(operand)) {
      return [];
    }
    const flowType = this.#checker.getTypeAtLocation(operand);
    if ((flowType.flags & ts.TypeFlags.Any) === 0 || isErrorType(flowType)) {
      return [];
    }
    const demanded = demandedType();
    if (!demanded || isTopType(demanded) || isErrorType(demanded)) {
      return [];
    }
    return [
      {
        kind: "forwarding",
        node,
        operand,
        label,
        test: this.#tests.type(demanded),
      },
    ];
  }

  #forwardedArguments(call: ts.CallExpression): readonly Recovery[] {
    const callee = skipParentheses(call.expression);
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : callee.getText();
    return call.arguments.flatMap((argument) =>
      ts.isSpreadElement(argument)
        ? []
        : this.#forwarded(
            argument,
            argument,
            () => this.#checker.getContextualType(argument),
            `passing it to \`${name}\``
          )
    );
  }

  #declaration(declaration: ts.VariableDeclaration): readonly Recovery[] {
    if (!declaration.type) {
      return [];
    }
    const { type } = declaration;
    return this.#forwarded(
      declaration,
      declaration.initializer,
      () => this.#checker.getTypeFromTypeNode(type),
      `the \`${declaration.type.getText()}\` declaration`
    );
  }

  #returned(statement: ts.ReturnStatement): readonly Recovery[] {
    const owner = ts.findAncestor(statement.parent, ts.isFunctionLike);
    if (!owner?.type || !statement.expression) {
      return [];
    }
    const { type } = owner;
    const demanded = () => {
      const declared = this.#checker.getTypeFromTypeNode(type);
      return (ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async) !== 0
        ? this.#checker.getAwaitedType(declared)
        : declared;
    };
    return this.#forwarded(
      statement,
      statement.expression,
      demanded,
      `returning it as \`${type.getText()}\``
    );
  }

  #assignment(binary: ts.BinaryExpression): readonly Recovery[] {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      return [];
    }
    return this.#forwarded(
      binary,
      binary.right,
      () => this.#checker.getTypeAtLocation(binary.left),
      "the assignment"
    );
  }

  #comparison(binary: ts.BinaryExpression): readonly Recovery[] {
    const operator = binary.operatorToken.kind;
    if (operator === ts.SyntaxKind.InKeyword) {
      return this.#inCheck(binary);
    }
    if (operator === ts.SyntaxKind.InstanceOfKeyword) {
      return this.#instanceofCheck(binary);
    }
    if (!EQUALITY_OPERATOR_KINDS.has(operator)) {
      return [];
    }
    const left = skipParentheses(binary.left);
    const right = skipParentheses(binary.right);
    return [
      ...this.#typeofCheck(binary, left, right),
      ...this.#typeofCheck(binary, right, left),
      ...this.#discriminantCheck(binary, left, right, "comparison"),
      ...this.#discriminantCheck(binary, right, left, "comparison"),
    ];
  }

  #typeofCheck(
    node: ts.Node,
    probe: ts.Expression,
    tag: ts.Expression
  ): readonly Recovery[] {
    if (
      !ts.isTypeOfExpression(probe) ||
      !ts.isStringLiteralLike(tag) ||
      !this.#relevance.traces(probe.expression)
    ) {
      return [];
    }
    const test = this.#tests.tag(tag.text);
    return test
      ? [
          {
            kind: "typeof",
            node,
            operand: probe.expression,
            label: "the `typeof` check",
            test,
          },
        ]
      : [];
  }

  #inCheck(binary: ts.BinaryExpression): readonly Recovery[] {
    const key = skipParentheses(binary.left);
    if (!ts.isStringLiteralLike(key) || !this.#relevance.traces(binary.right)) {
      return [];
    }
    const test = this.#tests.key(key.text);
    return [
      {
        kind: "in",
        node: binary,
        operand: binary.right,
        label: "the `in` check",
        test,
      },
    ];
  }

  #instanceofCheck(binary: ts.BinaryExpression): readonly Recovery[] {
    if (!this.#relevance.traces(binary.left)) {
      return [];
    }
    const [construct] = this.#checker
      .getTypeAtLocation(binary.right)
      .getConstructSignatures();
    if (!construct) {
      return [];
    }
    return [
      {
        kind: "instanceof",
        node: binary,
        operand: binary.left,
        label: "the `instanceof` check",
        test: this.#tests.type(
          this.#checker.getReturnTypeOfSignature(construct)
        ),
      },
    ];
  }

  #discriminantCheck(
    node: ts.Node,
    access: ts.Expression,
    literal: ts.Expression,
    role: "comparison" | "case"
  ): readonly Recovery[] {
    if (
      !(
        ts.isPropertyAccessExpression(access) ||
        ts.isElementAccessExpression(access)
      ) ||
      isNullishLiteral(literal) ||
      !this.#relevance.declaresUnion(access.expression)
    ) {
      return [];
    }
    const key = memberKeyText(access);
    const checker = this.#checker;
    const literalType = checker.getTypeAtLocation(literal);
    const unit =
      literalType.isLiteral() ||
      (literalType.flags & ts.TypeFlags.BooleanLiteral) !== 0;
    if (key === null || !unit || !this.#discriminates(access.expression, key)) {
      return [];
    }
    const test = this.#tests.discriminant(key, literalType);
    return [
      {
        kind: "discriminant",
        node,
        operand: access.expression,
        label: `the \`${key}\` ${role}`,
        test,
      },
    ];
  }

  #discriminates(subject: ts.Expression, key: string): boolean {
    const checker = this.#checker;
    const flowType = checker.getTypeAtLocation(subject).getNonNullableType();
    if (!flowType.isUnion()) {
      return false;
    }
    return flowType.types.every((member) => {
      const property = checker.getPropertyOfType(member, key);
      const keyType = property && checker.getTypeOfSymbol(property);
      return Boolean(
        keyType &&
        (keyType.isUnion() ? keyType.types : [keyType]).every(
          (part) =>
            part.isLiteral() ||
            (part.flags &
              (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Undefined)) !==
              0
        )
      );
    });
  }

  #switchCases(statement: ts.SwitchStatement): readonly Recovery[] {
    const subject = skipParentheses(statement.expression);
    return statement.caseBlock.clauses.flatMap((clause) => {
      if (!ts.isCaseClause(clause)) {
        return [];
      }
      const label = skipParentheses(clause.expression);
      if (ts.isTypeOfExpression(subject)) {
        return this.#typeofCheck(clause, subject, label);
      }
      return this.#discriminantCheck(clause, subject, label, "case");
    });
  }
}
