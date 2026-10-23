import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";
import {
  EQUALITY_OPERATOR_KINDS,
  isEarlyExitGuard,
  isNullishLiteral,
  memberKeyText,
} from "./narrowing-syntax.ts";
import { skipParentheses } from "./widening-recoveries.ts";
import { typeofTagMatches } from "./widening-tests.ts";
import type { Origin, SlotTracer, Step } from "./widening-trace.ts";

/** A condition known to hold where a recovery runs, read as a filter on the producer union at `path`. */
export type Guard = {
  readonly path: readonly Step[];
  readonly keeps: (member: ts.Type) => boolean;
};

type Fact = { readonly expression: ts.Expression; readonly holds: boolean };

type Probe = {
  readonly subject: ts.Expression;
  readonly keeps: (member: ts.Type) => boolean;
};

const OPEN_FLAGS =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;

const NULLISH_FLAGS =
  ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike;

function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function open(member: ts.Type): boolean {
  return isErrorType(member) || (member.flags & OPEN_FLAGS) !== 0;
}

function statementsOf(node: ts.Node): readonly ts.Statement[] {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  return ts.isCaseClause(node) || ts.isDefaultClause(node)
    ? node.statements
    : [];
}

/** The conditions known to hold at a node: the enclosing branches and earlier early exits. */
class ConditionFacts {
  readonly facts: Fact[] = [];

  collect(expression: ts.Expression, holds: boolean): void {
    const current = skipParentheses(expression);
    if (
      ts.isPrefixUnaryExpression(current) &&
      current.operator === ts.SyntaxKind.ExclamationToken
    ) {
      this.collect(current.operand, !holds);
      return;
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      const splits =
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && holds) ||
        (operator === ts.SyntaxKind.BarBarToken && !holds);
      if (splits) {
        this.collect(current.left, holds);
        this.collect(current.right, holds);
        return;
      }
    }
    this.facts.push({ expression: current, holds });
  }

  enclosing(parent: ts.Node, child: ts.Node): void {
    if (ts.isBinaryExpression(parent) && parent.right === child) {
      const operator = parent.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        this.collect(parent.left, true);
      } else if (operator === ts.SyntaxKind.BarBarToken) {
        this.collect(parent.left, false);
      }
    } else if (
      ts.isConditionalExpression(parent) &&
      parent.condition !== child
    ) {
      this.collect(parent.condition, parent.whenTrue === child);
    } else if (ts.isIfStatement(parent) && parent.expression !== child) {
      this.collect(parent.expression, parent.thenStatement === child);
    }
    for (const statement of statementsOf(parent)) {
      if (statement === child) {
        break;
      }
      if (isEarlyExitGuard(statement, child)) {
        this.collect(statement.expression, false);
      }
    }
  }
}

function present(member: ts.Type): boolean {
  return open(member) || (member.flags & NULLISH_FLAGS) === 0;
}

/** `subject != null`, `subject !== undefined` and `subject !== null` exclude nullish members. */
function nullishProbes(
  probed: ts.Expression,
  literal: ts.Expression,
  operator: ts.SyntaxKind
): readonly Probe[] {
  if (!isNullishLiteral(literal)) {
    return [];
  }
  let excluded = NULLISH_FLAGS;
  if (
    operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    excluded =
      literal.kind === ts.SyntaxKind.NullKeyword
        ? ts.TypeFlags.Null
        : ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  }
  return [
    {
      subject: probed,
      keeps: (member) => open(member) || (member.flags & excluded) === 0,
    },
  ];
}

/** A key for a path that ignores which node picked each element. */
function pathKey(path: readonly Step[]): string {
  return path
    .map((step) => {
      if (step.kind === "member") {
        return `.${JSON.stringify(step.key)}`;
      }
      return step.kind === "element" ? "[]" : "(awaited)";
    })
    .join("");
}

/**
 * Whether a guard on `guarded` speaks about the value at `recovered`: every
 * element it picks must be picked by the same node, since a condition on
 * `tokens[i]` says nothing about `tokens[i + 1]`.
 */
function sameElements(
  guarded: readonly Step[],
  recovered: readonly Step[]
): boolean {
  return guarded.every((step, index) => {
    if (step.kind !== "element") {
      return true;
    }
    const other = recovered[index];
    return (
      other?.kind === "element" &&
      step.anchor !== undefined &&
      other.anchor === step.anchor
    );
  });
}

function caseLabels(clause: ts.CaseClause): readonly ts.Expression[] {
  const clauses = clause.parent.clauses;
  const labels = [clause.expression];
  for (let index = clauses.indexOf(clause) - 1; index >= 0; index -= 1) {
    const previous = clauses[index];
    if (
      !previous ||
      !ts.isCaseClause(previous) ||
      previous.statements.length > 0
    ) {
      break;
    }
    labels.push(previous.expression);
  }
  return labels;
}

/** Reads the conditions that dominate a recovery and that probe the same slot it recovers. */
export class GuardReader {
  readonly #checker: ts.TypeChecker;
  readonly #tracer: SlotTracer;

  constructor(checker: ts.TypeChecker, tracer: SlotTracer) {
    this.#checker = checker;
    this.#tracer = tracer;
  }

  /**
   * The guards at a recovery `node` on the value `recovered` traces to. A
   * `case` clause that is itself the recovery is not a guard on it.
   */
  guardsAt(node: ts.Node, recovered: Origin): readonly Guard[] {
    const conditions = new ConditionFacts();
    const probes: Probe[] = [];
    let current: ts.Node = node;
    while (!ts.isSourceFile(current)) {
      const parent = current.parent;
      conditions.enclosing(parent, current);
      if (ts.isCaseClause(current) && current !== node) {
        probes.push(...this.#caseProbes(current));
      }
      current = parent;
    }
    probes.push(...conditions.facts.flatMap((fact) => this.#probes(fact)));
    return probes.flatMap((probe) => {
      const origin = this.#tracer.trace(probe.subject);
      return origin?.slot === recovered.slot &&
        origin.overrides.size === 0 &&
        origin.contributions.length === 0 &&
        sameElements(origin.path, recovered.path)
        ? [{ path: origin.path, keeps: probe.keeps }]
        : [];
    });
  }

  #probes(fact: Fact): readonly Probe[] {
    const expression = fact.expression;
    if (
      ts.isIdentifier(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      return fact.holds ? [{ subject: expression, keeps: present }] : [];
    }
    if (!ts.isBinaryExpression(expression)) {
      return [];
    }
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.InKeyword) {
      const key = skipParentheses(expression.left);
      return fact.holds && ts.isStringLiteralLike(key)
        ? [{ subject: expression.right, keeps: this.#hasKey(key.text) }]
        : [];
    }
    if (!EQUALITY_OPERATOR_KINDS.has(operator)) {
      return [];
    }
    const equal =
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const left = skipParentheses(expression.left);
    const right = skipParentheses(expression.right);
    if (equal !== fact.holds) {
      return [
        ...nullishProbes(left, right, operator),
        ...nullishProbes(right, left, operator),
      ];
    }
    return [
      ...this.#equalityProbes(left, [right]),
      ...this.#equalityProbes(right, [left]),
    ];
  }

  #caseProbes(clause: ts.CaseClause): readonly Probe[] {
    const subject = skipParentheses(clause.parent.parent.expression);
    return this.#equalityProbes(subject, caseLabels(clause));
  }

  #equalityProbes(
    probed: ts.Expression,
    labels: readonly ts.Expression[]
  ): readonly Probe[] {
    const literals = labels.map(skipParentheses);
    if (ts.isTypeOfExpression(probed)) {
      const tags = literals.flatMap((literal) =>
        ts.isStringLiteralLike(literal) ? [literal.text] : []
      );
      return tags.length === literals.length
        ? [
            {
              subject: probed.expression,
              keeps: (member) =>
                open(member) ||
                tags.some((tag) => typeofTagMatches(tag, member)),
            },
          ]
        : [];
    }
    if (
      !(
        ts.isPropertyAccessExpression(probed) ||
        ts.isElementAccessExpression(probed)
      ) ||
      literals.some(isNullishLiteral)
    ) {
      return [];
    }
    const key = memberKeyText(probed);
    const literalTypes = literals.map((literal) =>
      this.#checker.getTypeAtLocation(literal)
    );
    return key === null
      ? []
      : [
          {
            subject: probed.expression,
            keeps: this.#admitsAny(key, literalTypes),
          },
        ];
  }

  #hasKey(key: string) {
    return (member: ts.Type): boolean =>
      open(member) ||
      Boolean(
        this.#checker.getPropertyOfType(member, key) ??
        this.#checker.getIndexInfosOfType(member).length
      );
  }

  #admitsAny(key: string, literalTypes: readonly ts.Type[]) {
    return (member: ts.Type): boolean => {
      if (open(member)) {
        return true;
      }
      const property = this.#checker.getPropertyOfType(member, key);
      if (!property) {
        return false;
      }
      const keyType = this.#checker.getTypeOfSymbol(property);
      return literalTypes.some(
        (literalType) =>
          open(keyType) ||
          this.#checker.isTypeAssignableTo(literalType, keyType)
      );
    };
  }
}

/**
 * Projects producer types along a recovered path, applying the guards that
 * hold there. `never` members carry no values and drop out.
 */
export class PathProjection {
  readonly #checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  project(
    type: ts.Type,
    path: readonly Step[],
    guards: readonly Guard[]
  ): readonly ts.Type[] {
    const keyed = guards.map((guard) => ({
      key: pathKey(guard.path),
      keeps: guard.keeps,
    }));
    let current = members(type);
    for (let depth = 0; depth <= path.length; depth += 1) {
      const step = path[depth - 1];
      if (step) {
        current = [
          ...new Set(current.flatMap((member) => this.#step(member, step))),
        ];
      }
      const prefix = pathKey(path.slice(0, depth));
      const applicable = keyed.filter((guard) => guard.key === prefix);
      current = current.filter(
        (member) =>
          (member.flags & ts.TypeFlags.Never) === 0 &&
          applicable.every((guard) => guard.keeps(member))
      );
    }
    return current;
  }

  /** The types a target demands at a path inside it; an empty list demands nothing. */
  demandedAt(target: ts.Type, path: readonly Step[]): readonly ts.Type[] {
    let current: readonly ts.Type[] = members(target);
    for (const step of path) {
      current = current.flatMap((member) =>
        open(member) || step.kind === "await"
          ? []
          : this.#demandedStep(member, step)
      );
    }
    return current;
  }

  #demandedStep(member: ts.Type, step: Step): readonly ts.Type[] {
    const checker = this.#checker;
    if (step.kind === "member") {
      const property = checker.getPropertyOfType(member, step.key);
      const indexed = checker.getIndexTypeOfType(member, ts.IndexKind.String);
      if (property) {
        return members(checker.getTypeOfSymbol(property));
      }
      return indexed ? members(indexed) : [];
    }
    const element = checker.getIndexTypeOfType(member, ts.IndexKind.Number);
    return element ? members(element) : [];
  }

  #step(member: ts.Type, step: Step): readonly ts.Type[] {
    const checker = this.#checker;
    if (open(member) && (member.flags & ts.TypeFlags.TypeParameter) === 0) {
      return [member];
    }
    if ((member.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(member);
      return constraint && constraint !== member
        ? members(constraint).flatMap((part) => this.#step(part, step))
        : [checker.getUnknownType()];
    }
    if (step.kind === "await") {
      return members(checker.getAwaitedType(member) ?? member);
    }
    if ((member.flags & NULLISH_FLAGS) !== 0) {
      return [checker.getUndefinedType()];
    }
    return step.kind === "member"
      ? this.#member(member, step.key)
      : this.#element(member);
  }

  /**
   * A key the type does not declare reads as `unknown`: object types are open,
   * so a value may carry the key with any value at run time.
   */
  #member(member: ts.Type, key: string): readonly ts.Type[] {
    const checker = this.#checker;
    const owner =
      (member.flags & PRIMITIVE_FLAGS) === 0
        ? member
        : checker.getApparentType(member);
    const property = checker.getPropertyOfType(owner, key);
    if (property) {
      return members(checker.getTypeOfSymbol(property));
    }
    const numeric = key.trim() !== "" && Number.isFinite(Number(key));
    const indexed =
      (numeric
        ? checker.getIndexTypeOfType(owner, ts.IndexKind.Number)
        : undefined) ?? checker.getIndexTypeOfType(owner, ts.IndexKind.String);
    return indexed ? members(indexed) : [checker.getUnknownType()];
  }

  #element(member: ts.Type): readonly ts.Type[] {
    const checker = this.#checker;
    if (checker.isTupleType(member)) {
      return checker.getTypeArguments(member).flatMap(members);
    }
    const numberIndex = checker.getIndexTypeOfType(member, ts.IndexKind.Number);
    if (numberIndex) {
      return members(numberIndex);
    }
    if ((member.flags & ts.TypeFlags.StringLike) !== 0) {
      return [checker.getStringType()];
    }
    const stringIndex = checker.getIndexTypeOfType(member, ts.IndexKind.String);
    return stringIndex ? members(stringIndex) : [checker.getUnknownType()];
  }
}
