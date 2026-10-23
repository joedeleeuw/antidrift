import ts from "typescript";

import {
  memberKeyText,
  skipTransparentExpressions,
} from "./narrowing-syntax.ts";
import {
  arrayCallbackReceiver,
  isTopType,
  skipParentheses,
} from "./widening-recoveries.ts";

/**
 * One step from a slot's value to a derived value. An element step carries
 * the node that picked the element (an element access, a `for...of` loop, an
 * array callback parameter or an array binding element), because a condition
 * on one element says nothing about another.
 */
export type Step =
  | { readonly kind: "member"; readonly key: string }
  | { readonly kind: "element"; readonly anchor?: ts.Node }
  | { readonly kind: "await" };

type SlotKind = "binding" | "cast" | "parameter";

/** A declared contract a value passes through: an annotated binding, an initializer cast to a broad type, or an annotated parameter. */
export type Slot = {
  readonly kind: SlotKind;
  readonly declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
  readonly subject: string;
  readonly binding: ts.Identifier | null;
  readonly contract: ts.TypeNode;
  readonly declared: ts.Type;
  readonly castOperand: ts.Expression | null;
};

/** A value that joins the slot-derived value without coming from the slot, such as a `??` fallback. */
type Contribution = {
  readonly expression: ts.Expression;
  readonly path: readonly Step[];
};

export type Origin = {
  readonly slot: Slot;
  readonly path: readonly Step[];
  readonly overrides: ReadonlyMap<string, ts.Expression>;
  readonly contributions: readonly Contribution[];
};

type Walk = {
  readonly origins: ReadonlyArray<Omit<Origin, "contributions">>;
  readonly contributions: readonly Contribution[];
  readonly unsupported: boolean;
};

type Resolution =
  | {
      readonly kind: "slot";
      readonly slot: Slot;
      readonly steps: readonly Step[];
    }
  | {
      readonly kind: "derived";
      readonly expression: ts.Expression;
      readonly steps: readonly Step[];
    }
  | null;

const AWAIT_STEP: Step = { kind: "await" };

const WALK_DEPTH = 64;

const UNSUPPORTED: Walk = { origins: [], contributions: [], unsupported: true };

const NO_OVERRIDES: ReadonlyMap<string, ts.Expression> = new Map();

const SUBJECT_LENGTH = 40;

function leaf(expression: ts.Expression, path: readonly Step[]): Walk {
  return {
    origins: [],
    contributions: [{ expression, path }],
    unsupported: false,
  };
}

function originWalk(
  slot: Slot,
  path: readonly Step[],
  overrides = NO_OVERRIDES
): Walk {
  return {
    origins: [{ slot, path, overrides }],
    contributions: [],
    unsupported: false,
  };
}

function merge(walks: readonly Walk[]): Walk {
  return {
    origins: walks.flatMap((walk) => walk.origins),
    contributions: walks.flatMap((walk) => walk.contributions),
    unsupported: walks.some((walk) => walk.unsupported),
  };
}

function memberStep(key: string): Step {
  return { kind: "member", key };
}

function elementStep(anchor: ts.Node): Step {
  return { kind: "element", anchor };
}

function sameSteps(left: readonly Step[], right: readonly Step[]): boolean {
  return (
    left.length === right.length &&
    left.every((step, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.kind === step.kind &&
        (step.kind !== "member" ||
          (other.kind === "member" && other.key === step.key)) &&
        (step.kind !== "element" ||
          (other.kind === "element" && other.anchor === step.anchor))
      );
    })
  );
}

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/u;

export function pathText(path: readonly Step[]): string {
  return path
    .map((step) => {
      if (step.kind === "member") {
        if (IDENTIFIER_KEY.test(step.key)) {
          return `.${step.key}`;
        }
        return /^\d+$/u.test(step.key)
          ? `[${step.key}]`
          : `[${JSON.stringify(step.key)}]`;
      }
      return step.kind === "element" ? "[]" : "(awaited)";
    })
    .join("")
    .replace(/^\./u, "");
}

function propertyNameText(name: ts.Node | undefined): string | null {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const key = skipParentheses(name.expression);
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
      ? key.text
      : null;
  }
  return null;
}

function patternStep(element: ts.BindingElement): Step | null {
  const key = propertyNameText(element.propertyName ?? element.name);
  return key === null ? null : memberStep(key);
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

function loopStatement(declaration: ts.VariableDeclaration) {
  const list = declaration.parent;
  const statement = list.parent;
  return (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) &&
    statement.initializer === list
    ? statement
    : null;
}

function iteratedResolution(
  loop: ts.ForOfStatement | ts.ForInStatement,
  steps: readonly Step[]
): Resolution {
  return ts.isForOfStatement(loop) && !loop.awaitModifier
    ? {
        kind: "derived",
        expression: loop.expression,
        steps: [elementStep(loop), ...steps],
      }
    : null;
}

function truncate(text: string): string {
  const flat = text.replaceAll(/\s+/gu, " ");
  return flat.length > SUBJECT_LENGTH
    ? `${flat.slice(0, SUBJECT_LENGTH - 1)}…`
    : flat;
}

/**
 * Follows a recovered value back to the slot it derives from, through
 * aliases, property and element access, destructuring, `for...of` and array
 * callbacks, `await`, `??`, `||`, conditionals and object spread.
 */
export class SlotTracer {
  readonly #checker: ts.TypeChecker;
  readonly #slots = new Map<ts.Node, Slot | null>();

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  trace(expression: ts.Expression): Origin | null {
    const walk = this.#walk(expression, [], 0);
    const [first, ...rest] = walk.origins;
    if (
      walk.unsupported ||
      !first ||
      rest.some(
        (other) =>
          other.slot !== first.slot ||
          !sameSteps(other.path, first.path) ||
          other.overrides.size > 0 ||
          first.overrides.size > 0
      )
    ) {
      return null;
    }
    return { ...first, contributions: walk.contributions };
  }

  slotOf(declaration: ts.Node): Slot | null {
    const known = this.#slots.get(declaration);
    if (known !== undefined) {
      return known;
    }
    const slot = this.#readSlot(declaration);
    this.#slots.set(declaration, slot);
    return slot;
  }

  #readSlot(declaration: ts.Node): Slot | null {
    const checker = this.#checker;
    if (ts.isParameter(declaration)) {
      const { name, type } = declaration;
      if (!type || (ts.isIdentifier(name) && name.text === "this")) {
        return null;
      }
      return {
        kind: "parameter",
        declaration,
        subject: truncate(name.getText()),
        binding: ts.isIdentifier(name) ? name : null,
        contract: type,
        declared: checker.getTypeFromTypeNode(type),
        castOperand: null,
      };
    }
    if (!ts.isVariableDeclaration(declaration)) {
      return null;
    }
    const { name, type } = declaration;
    if (!ts.isIdentifier(name)) {
      return null;
    }
    const base = { declaration, subject: name.text, binding: name };
    if (type) {
      return {
        ...base,
        kind: "binding",
        contract: type,
        declared: checker.getTypeFromTypeNode(type),
        castOperand: null,
      };
    }
    const initializer =
      declaration.initializer && skipParentheses(declaration.initializer);
    if (
      !initializer ||
      !(
        ts.isAsExpression(initializer) ||
        ts.isTypeAssertionExpression(initializer)
      )
    ) {
      return null;
    }
    const declared = checker.getTypeFromTypeNode(initializer.type);
    return this.#broad(declared)
      ? {
          ...base,
          kind: "cast",
          contract: initializer.type,
          declared,
          castOperand: initializer.expression,
        }
      : null;
  }

  #broad(type: ts.Type): boolean {
    if (isTopType(type) || (type.flags & ts.TypeFlags.NonPrimitive) !== 0) {
      return true;
    }
    const checker = this.#checker;
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      checker.getPropertiesOfType(type).length === 0 &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0 &&
      checker.getIndexInfosOfType(type).every((index) => isTopType(index.type))
    );
  }

  #walk(
    expression: ts.Expression,
    suffix: readonly Step[],
    depth: number
  ): Walk {
    if (depth > WALK_DEPTH) {
      return UNSUPPORTED;
    }
    const current = skipTransparentExpressions(expression);
    const next = depth + 1;
    if (ts.isIdentifier(current)) {
      const resolution = this.#identifier(current);
      if (!resolution) {
        return leaf(current, suffix);
      }
      const path = [...resolution.steps, ...suffix];
      return resolution.kind === "slot"
        ? originWalk(resolution.slot, path)
        : this.#walk(resolution.expression, path, next);
    }
    if (ts.isPropertyAccessExpression(current)) {
      return this.#walk(
        current.expression,
        [memberStep(current.name.text), ...suffix],
        next
      );
    }
    if (ts.isElementAccessExpression(current)) {
      const key = memberKeyText(current);
      const step = key === null ? elementStep(current) : memberStep(key);
      return this.#walk(current.expression, [step, ...suffix], next);
    }
    if (ts.isAwaitExpression(current)) {
      return this.#walk(current.expression, [AWAIT_STEP, ...suffix], next);
    }
    if (ts.isConditionalExpression(current)) {
      return merge([
        this.#walk(current.whenTrue, suffix, next),
        this.#walk(current.whenFalse, suffix, next),
      ]);
    }
    if (ts.isBinaryExpression(current)) {
      return this.#fallback(current, suffix, next);
    }
    if (ts.isObjectLiteralExpression(current)) {
      return this.#objectLiteral(current, suffix, next);
    }
    return leaf(current, suffix);
  }

  #fallback(
    binary: ts.BinaryExpression,
    suffix: readonly Step[],
    depth: number
  ): Walk {
    const operator = binary.operatorToken.kind;
    if (
      operator !== ts.SyntaxKind.QuestionQuestionToken &&
      operator !== ts.SyntaxKind.BarBarToken
    ) {
      return leaf(binary, suffix);
    }
    return merge([
      this.#walk(binary.left, suffix, depth),
      this.#walk(binary.right, suffix, depth),
    ]);
  }

  #identifier(identifier: ts.Identifier): Resolution {
    const declaration =
      this.#checker.getSymbolAtLocation(identifier)?.valueDeclaration;
    if (declaration && ts.isParameter(declaration)) {
      return this.#parameter(declaration);
    }
    if (declaration && ts.isBindingElement(declaration)) {
      return this.#bindingElement(declaration);
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
      return this.#variable(declaration);
    }
    return null;
  }

  #variable(declaration: ts.VariableDeclaration): Resolution {
    const loop = loopStatement(declaration);
    if (loop) {
      return iteratedResolution(loop, []);
    }
    const slot = this.slotOf(declaration);
    if (slot) {
      return { kind: "slot", slot, steps: [] };
    }
    return declaration.initializer && isConstDeclaration(declaration)
      ? { kind: "derived", expression: declaration.initializer, steps: [] }
      : null;
  }

  #parameter(parameter: ts.ParameterDeclaration): Resolution {
    const slot = this.slotOf(parameter);
    if (slot) {
      return { kind: "slot", slot, steps: [] };
    }
    const receiver = this.#elementSource(parameter);
    return receiver
      ? {
          kind: "derived",
          expression: receiver,
          steps: [elementStep(parameter)],
        }
      : null;
  }

  #elementSource(parameter: ts.ParameterDeclaration): ts.Expression | null {
    if (parameter.type) {
      return null;
    }
    const receiver = arrayCallbackReceiver(parameter);
    return receiver &&
      this.#checker.isArrayLikeType(this.#checker.getTypeAtLocation(receiver))
      ? receiver
      : null;
  }

  #bindingElement(element: ts.BindingElement): Resolution {
    const steps: Step[] = [];
    let node: ts.Node = element;
    while (ts.isBindingElement(node)) {
      const pattern = node.parent;
      const step = ts.isObjectBindingPattern(pattern)
        ? patternStep(node)
        : elementStep(node);
      if (node.dotDotDotToken || node.initializer || !step) {
        return null;
      }
      steps.unshift(step);
      node = pattern.parent;
    }
    if (ts.isParameter(node)) {
      const slot = this.slotOf(node);
      if (slot) {
        return { kind: "slot", slot, steps };
      }
      const receiver = this.#elementSource(node);
      return receiver
        ? {
            kind: "derived",
            expression: receiver,
            steps: [elementStep(node), ...steps],
          }
        : null;
    }
    if (!ts.isVariableDeclaration(node) || node.type) {
      return null;
    }
    const loop = loopStatement(node);
    if (loop) {
      return iteratedResolution(loop, steps);
    }
    return node.initializer && isConstDeclaration(node)
      ? { kind: "derived", expression: node.initializer, steps }
      : null;
  }

  #objectLiteral(
    literal: ts.ObjectLiteralExpression,
    suffix: readonly Step[],
    depth: number
  ): Walk {
    const [spread, ...rest] = literal.properties;
    if (!spread || !ts.isSpreadAssignment(spread)) {
      return leaf(literal, suffix);
    }
    const overrides = new Map<string, ts.Expression>();
    for (const property of rest) {
      if (ts.isShorthandPropertyAssignment(property)) {
        overrides.set(property.name.text, property.name);
        continue;
      }
      const key = ts.isPropertyAssignment(property)
        ? propertyNameText(property.name)
        : null;
      if (!key || !ts.isPropertyAssignment(property)) {
        return leaf(literal, suffix);
      }
      overrides.set(key, property.initializer);
    }
    const [first, ...remainder] = suffix;
    if (first) {
      const override = first.kind === "member" && overrides.get(first.key);
      if (override) {
        return this.#walk(override, remainder, depth);
      }
      return first.kind === "member"
        ? this.#walk(spread.expression, suffix, depth)
        : leaf(literal, suffix);
    }
    const inner = this.#walk(spread.expression, [], depth);
    const [only, ...others] = inner.origins;
    if (
      inner.unsupported ||
      inner.contributions.length > 0 ||
      !only ||
      others.length > 0 ||
      only.overrides.size > 0
    ) {
      return leaf(literal, suffix);
    }
    return originWalk(only.slot, only.path, overrides);
  }
}
