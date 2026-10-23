import ts from "typescript";

import { memberKeyText } from "../boundary/narrowing-syntax.ts";
import type { Slot, Step } from "../boundary/widening-trace.ts";
import { ProgramCallers } from "./widening-callers.ts";
import type { CallerSearch } from "./widening-callers.ts";

/** A value the analysis sees flowing into a slot, at `path` inside it. */
export type Producer = {
  readonly node: ts.Node;
  readonly type: ts.Type;
  readonly path: readonly Step[];
};

export type ProducerSet =
  | {
      readonly kind: "producers";
      readonly producers: readonly Producer[];
      readonly escapes: readonly ts.Node[];
    }
  | Exclude<CallerSearch, { readonly kind: "calls" }>;

type Use =
  | { readonly kind: "read" }
  | { readonly kind: "escape" }
  | { readonly kind: "write"; readonly producers: readonly Producer[] }
  | { readonly kind: "incomplete"; readonly cause: string };

const READ: Use = { kind: "read" };

const ESCAPE: Use = { kind: "escape" };

const ELEMENT_STEP: Step = { kind: "element" };

const APPENDING_METHODS: ReadonlySet<string> = new Set(["push", "unshift"]);

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
]);

const MUTATING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "deleteProperty",
  "set",
  "setPrototypeOf",
]);

const PLAIN_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

function incomplete(cause: string): ProducerSet {
  return { kind: "incomplete", cause, bound: null };
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Parentheses, a non-null assertion or a cast around `node`: the same value, so a write through it writes `node`. */
function isTransparentWrapper(
  parent: ts.Node,
  node: ts.Expression
): parent is ts.Expression {
  return (
    (ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    parent.expression === node
  );
}

function outermostWrapper(node: ts.Expression): ts.Expression {
  let current = node;
  while (isTransparentWrapper(current.parent, current)) {
    current = current.parent;
  }
  return current;
}

function retainsReference(parent: ts.Node, reference: ts.Expression): boolean {
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.right === reference &&
      isAssignmentOperator(parent.operatorToken.kind)
    );
  }
  return (
    (ts.isVariableDeclaration(parent) &&
      parent.initializer === reference &&
      ts.isIdentifier(parent.name)) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === reference) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isYieldExpression(parent) ||
    ts.isJsxExpression(parent) ||
    ts.isExportAssignment(parent) ||
    (ts.isArrowFunction(parent) && parent.body === reference)
  );
}

function scopeOf(declaration: Slot["declaration"]): ts.Node {
  if (ts.isParameter(declaration)) {
    return declaration.parent;
  }
  return (
    ts.findAncestor(
      declaration.parent,
      (node) => ts.isFunctionLike(node) || ts.isSourceFile(node)
    ) ?? declaration.getSourceFile()
  );
}

/**
 * Collects what flows into a slot: the initializer or cast operand, later
 * assignments and writes into the bound value, and, for a parameter, the
 * arguments at every in-program call. Uses that let the value leave the
 * analysis (stored elsewhere or passed to a call that may write into it) are
 * kept as escapes for the decision to weigh.
 */
export class SlotProducers {
  readonly #checker: ts.TypeChecker;
  readonly #program: ts.Program;
  readonly #callers: ProgramCallers;
  readonly #sets = new Map<Slot, ProducerSet>();

  constructor(program: ts.Program, checker: ts.TypeChecker) {
    this.#program = program;
    this.#checker = checker;
    this.#callers = new ProgramCallers(program, checker);
  }

  of(slot: Slot): ProducerSet {
    const known = this.#sets.get(slot);
    if (known) {
      return known;
    }
    const collected = this.#collect(slot);
    this.#sets.set(slot, collected);
    return collected;
  }

  #collect(slot: Slot): ProducerSet {
    const local = this.#localUses(slot);
    if (local.kind !== "producers") {
      return local;
    }
    const sources = this.#sources(slot);
    if (sources.kind !== "producers") {
      return sources;
    }
    const producers = [...sources.producers, ...local.producers];
    return producers.length > 0
      ? { kind: "producers", producers, escapes: local.escapes }
      : incomplete("nothing flows into it");
  }

  #producer(node: ts.Expression, path: readonly Step[]): Producer {
    return { node, type: this.#checker.getTypeAtLocation(node), path };
  }

  #sources(slot: Slot): ProducerSet {
    const declaration = slot.declaration;
    if (ts.isParameter(declaration)) {
      return this.#arguments(declaration);
    }
    const source = slot.castOperand ?? declaration.initializer;
    if (source) {
      return {
        kind: "producers",
        producers: [this.#producer(source, [])],
        escapes: [],
      };
    }
    const declared = ts.isVariableDeclarationList(declaration.parent);
    return {
      kind: "producers",
      producers: declared
        ? [
            {
              node: declaration,
              type: this.#checker.getUndefinedType(),
              path: [],
            },
          ]
        : [],
      escapes: [],
    };
  }

  #arguments(parameter: ts.ParameterDeclaration): ProducerSet {
    if (parameter.dotDotDotToken) {
      return incomplete("it is a rest parameter");
    }
    const owner = parameter.parent;
    const search = this.#callers.of(owner);
    if (search.kind !== "calls") {
      return search;
    }
    const index = owner.parameters.indexOf(parameter);
    const producers: Producer[] = [];
    for (const call of search.calls) {
      const spread = call.arguments.findIndex(ts.isSpreadElement);
      if (spread >= 0 && spread <= index) {
        return incomplete("a call spreads its arguments");
      }
      const argument = call.arguments[index];
      if (argument) {
        producers.push(this.#producer(argument, []));
      }
      const defaulted = !argument || this.#mayBeUndefined(argument);
      if (defaulted && parameter.initializer) {
        producers.push(this.#producer(parameter.initializer, []));
      } else if (!argument) {
        producers.push({
          node: call,
          type: this.#checker.getUndefinedType(),
          path: [],
        });
      }
    }
    return { kind: "producers", producers, escapes: [] };
  }

  #mayBeUndefined(argument: ts.Expression): boolean {
    const type = this.#checker.getTypeAtLocation(argument);
    return (type.isUnion() ? type.types : [type]).some(
      (member) =>
        (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
    );
  }

  #localUses(slot: Slot): ProducerSet {
    const binding = slot.binding;
    const symbol = binding && this.#checker.getSymbolAtLocation(binding);
    if (!binding || !symbol) {
      return { kind: "producers", producers: [], escapes: [] };
    }
    const producers: Producer[] = [];
    const escapes: ts.Node[] = [];
    const stops: string[] = [];
    const visit = (node: ts.Node): void => {
      if (stops.length > 0) {
        return;
      }
      if (
        ts.isIdentifier(node) &&
        node !== binding &&
        node.text === binding.text &&
        this.#valueSymbol(node) === symbol
      ) {
        const use = this.#use(node);
        if (use.kind === "write") {
          producers.push(...use.producers);
        } else if (use.kind === "escape") {
          escapes.push(node);
        } else if (use.kind === "incomplete") {
          stops.push(use.cause);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scopeOf(slot.declaration));
    const [stop] = stops;
    return stop === undefined
      ? { kind: "producers", producers, escapes }
      : incomplete(stop);
  }

  #valueSymbol(identifier: ts.Identifier): ts.Symbol | undefined {
    const parent = identifier.parent;
    return ts.isShorthandPropertyAssignment(parent) &&
      parent.name === identifier
      ? this.#checker.getShorthandAssignmentValueSymbol(parent)
      : this.#checker.getSymbolAtLocation(identifier);
  }

  #use(identifier: ts.Identifier): Use {
    let node: ts.Expression = identifier;
    const path: Step[] = [];
    for (;;) {
      const parent = node.parent;
      if (isTransparentWrapper(parent, node)) {
        node = parent;
      } else if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      ) {
        const key = memberKeyText(parent);
        path.push(key === null ? ELEMENT_STEP : { kind: "member", key });
        node = parent;
      } else {
        break;
      }
    }
    const parent = node.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)
    ) {
      return PLAIN_ASSIGNMENTS.has(parent.operatorToken.kind)
        ? { kind: "write", producers: [this.#producer(parent.right, path)] }
        : { kind: "incomplete", cause: "a compound assignment writes it" };
    }
    if (
      ts.isDeleteExpression(parent) ||
      ((ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      return { kind: "incomplete", cause: "an update or delete writes it" };
    }
    return path.length > 0
      ? this.#memberUse(node, path)
      : this.#wholeUse(identifier);
  }

  #memberUse(access: ts.Expression, path: readonly Step[]): Use {
    const call = access.parent;
    const last = path.at(-1);
    if (
      !ts.isCallExpression(call) ||
      call.expression !== access ||
      last?.kind !== "member"
    ) {
      return READ;
    }
    if (path.length === 1 && APPENDING_METHODS.has(last.key)) {
      return call.arguments.some(ts.isSpreadElement)
        ? { kind: "incomplete", cause: `a spread ${last.key} writes it` }
        : {
            kind: "write",
            producers: call.arguments.map((argument) =>
              this.#producer(argument, [ELEMENT_STEP])
            ),
          };
    }
    return MUTATING_METHODS.has(last.key)
      ? { kind: "incomplete", cause: `${last.key} mutates it` }
      : READ;
  }

  #wholeUse(identifier: ts.Identifier): Use {
    const reference = outermostWrapper(identifier);
    const parent = reference.parent;
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(reference)
    ) {
      return this.#readOnlyCall(parent) ? READ : ESCAPE;
    }
    return retainsReference(parent, reference) ? ESCAPE : READ;
  }

  #readOnlyCall(call: ts.CallExpression | ts.NewExpression): boolean {
    const signature = this.#checker.getResolvedSignature(call);
    if (signature && this.#checker.getTypePredicateOfSignature(signature)) {
      return true;
    }
    const declaration = signature?.declaration;
    const callee = call.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : callee.getText();
    return Boolean(
      declaration &&
      this.#program.isSourceFileDefaultLibrary(declaration.getSourceFile()) &&
      !MUTATING_LIBRARY_CALLS.has(name)
    );
  }
}
