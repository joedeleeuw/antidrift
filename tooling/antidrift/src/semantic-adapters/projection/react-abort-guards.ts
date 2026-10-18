import { isFunctionLike } from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  isSyntaxTypeIn,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import type { ReactHookBindings } from "./react-hook-bindings.ts";
import { memberName, unwrapCasts } from "./react-state-syntax.ts";

export type AbortStatusGuard = {
  readonly block: object;
  readonly start?: number;
  readonly end: number;
};

export type AbortControllerScope = {
  isAbortController(name: string): boolean;
  isAbortControllerRef(name: string): boolean;
};

const EXIT_STATEMENT_TYPES = new Set([
  "ReturnStatement",
  "ThrowStatement",
  "BreakStatement",
  "ContinueStatement",
]);

const STATEMENT_CONTAINER_TYPES = new Set(["BlockStatement", "Program"]);

function isNewAbortController(node: unknown): boolean {
  const unwrapped = unwrapCasts(node);
  return (
    isSyntaxType(unwrapped, "NewExpression") &&
    identifierName(syntaxField(unwrapped, "callee")) === "AbortController"
  );
}

export function abortControllerDeclaration(
  init: unknown,
  hooks: ReactHookBindings
): "controller" | "ref" | null {
  if (isNewAbortController(init)) {
    return "controller";
  }
  return isSyntaxType(init, "CallExpression") &&
    hooks.isHookCallee(syntaxField(init, "callee"), "useRef") &&
    isNewAbortController(syntaxChildren(init, "arguments")[0])
    ? "ref"
    : null;
}

function rangeBound(node: unknown, index: 0 | 1): number | undefined {
  const range = syntaxField(node, "range");
  const bound: unknown = Array.isArray(range) ? range[index] : undefined;
  return typeof bound === "number" ? bound : undefined;
}

function statementExits(node: unknown): boolean {
  if (isSyntaxTypeIn(node, EXIT_STATEMENT_TYPES)) {
    return true;
  }
  if (isSyntaxType(node, "BlockStatement")) {
    return statementExits(syntaxChildren(node, "body").at(-1));
  }
  return (
    isSyntaxType(node, "IfStatement") &&
    statementExits(syntaxField(node, "consequent")) &&
    statementExits(syntaxField(node, "alternate"))
  );
}

function statementBlock(node: unknown): object | null {
  for (
    let parent = syntaxField(node, "parent");
    isSyntaxNode(parent) && !isFunctionLike(parent);
    parent = syntaxField(parent, "parent")
  ) {
    if (isSyntaxTypeIn(parent, STATEMENT_CONTAINER_TYPES)) {
      return parent;
    }
  }
  return null;
}

function isKnownAbortController(
  node: unknown,
  scope: AbortControllerScope
): boolean {
  const controller = unwrapCasts(node);
  const controllerName = identifierName(controller);
  if (controllerName !== null) {
    return scope.isAbortController(controllerName);
  }
  const refName = identifierName(
    unwrapCasts(syntaxField(controller, "object"))
  );
  return (
    isSyntaxType(controller, "MemberExpression") &&
    memberName(controller) === "current" &&
    refName !== null &&
    scope.isAbortControllerRef(refName)
  );
}

function isAbortStatusGuardTest(
  node: unknown,
  scope: AbortControllerScope
): boolean {
  const test = unwrapCasts(node);
  if (isSyntaxType(test, "LogicalExpression")) {
    return (
      isAbortStatusGuardTest(syntaxField(test, "left"), scope) ||
      isAbortStatusGuardTest(syntaxField(test, "right"), scope)
    );
  }
  const signal = unwrapCasts(syntaxField(test, "object"));
  return (
    isSyntaxType(test, "MemberExpression") &&
    memberName(test) === "aborted" &&
    isSyntaxType(signal, "MemberExpression") &&
    memberName(signal) === "signal" &&
    isKnownAbortController(syntaxField(signal, "object"), scope)
  );
}

export function abortStatusGuards(
  statement: unknown,
  scope: AbortControllerScope
): AbortStatusGuard[] {
  const test = syntaxField(statement, "test");
  const consequent = syntaxField(statement, "consequent");
  const negated = unwrapCasts(test);
  const guards: AbortStatusGuard[] = [];
  const block =
    isAbortStatusGuardTest(test, scope) && statementExits(consequent)
      ? statementBlock(statement)
      : null;
  if (block) {
    guards.push({
      block,
      end: rangeBound(statement, 1) ?? Number.NEGATIVE_INFINITY,
    });
  }
  if (
    isSyntaxType(negated, "UnaryExpression") &&
    syntaxField(negated, "operator") === "!" &&
    isAbortStatusGuardTest(syntaxField(negated, "argument"), scope) &&
    isSyntaxType(consequent, "BlockStatement")
  ) {
    guards.push({
      block: consequent,
      start: rangeBound(consequent, 0) ?? Number.NEGATIVE_INFINITY,
      end: rangeBound(consequent, 1) ?? Number.POSITIVE_INFINITY,
    });
  }
  return guards;
}

export function hasAbortStatusGuardFor(
  guards: readonly AbortStatusGuard[],
  node: unknown
): boolean {
  const block = statementBlock(node);
  const start = rangeBound(node, 0) ?? Number.POSITIVE_INFINITY;
  return (
    block !== null &&
    guards.some(
      (guard) =>
        guard.block === block &&
        (guard.start === undefined
          ? guard.end <= start
          : guard.start <= start && start <= guard.end)
    )
  );
}
