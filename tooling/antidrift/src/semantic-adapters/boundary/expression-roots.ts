import { nodeReader } from "../kernel/typescript-internals.ts";
import ts from "typescript";
import {
  ELEMENT,
  assertionKinds,
  logicalOperators,
} from "./boundary-contracts.ts";
import type { Root } from "./root-domain.ts";
import { unknownProvenance } from "./root-domain.ts";
import type { TraceContext } from "./trace-context.ts";
import { aliasTarget } from "../provenance/symbol-provenance.ts";
import {
  isAssertionChain,
  isWrapperExpression,
  safeExpressionKinds,
  wrapperKinds,
} from "./boundary-syntax.ts";

type NodeReader = (expression: ts.Node) => readonly Root[];
const binaryDispositions = new Map<
  ts.SyntaxKind,
  "both" | "right" | "concatenation"
>([
  ...[...logicalOperators].map((kind) => [kind, "both"] as const),
  [ts.SyntaxKind.QuestionQuestionEqualsToken, "both"],
  [ts.SyntaxKind.BarBarEqualsToken, "both"],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, "both"],
  [ts.SyntaxKind.EqualsToken, "right"],
  [ts.SyntaxKind.CommaToken, "right"],
  [ts.SyntaxKind.PlusToken, "concatenation"],
  [ts.SyntaxKind.PlusEqualsToken, "concatenation"],
]);
type ExpressionRootsContext = Pick<
  TraceContext,
  | "checker"
  | "contracts"
  | "declarations"
  | "algebra"
  | "sources"
  | "trace"
  | "withClaim"
  | "accessStep"
  | "elementStep"
  | "projected"
  | "bindingRoots"
  | "stringified"
  | "callRoots"
  | "constructionRoots"
  | "receivers"
>;
export class ExpressionRoots {
  readonly context: ExpressionRootsContext;
  readonly readers = new Map<ts.SyntaxKind, NodeReader>([
    ...[...safeExpressionKinds].map((kind) => [kind, () => []] as const),
    ...[...wrapperKinds]
      .filter((kind) => !assertionKinds.has(kind))
      .map(
        (kind) =>
          [
            kind,
            nodeReader(isWrapperExpression, (expression) =>
              expression.expression
                ? this.context.trace(expression.expression)
                : []
            ),
          ] as const
      ),
    ...[...assertionKinds].map(
      (kind) =>
        [
          kind,
          nodeReader(ts.isAssertionExpression, (expression) =>
            this.assertionRoots(expression)
          ),
        ] as const
    ),
    [
      ts.SyntaxKind.YieldExpression,
      nodeReader(ts.isYieldExpression, (expression) =>
        expression.asteriskToken && expression.expression
          ? this.context.trace(expression.expression)
          : unknownProvenance(expression, "yield receives the caller's input")
      ),
    ],
    [
      ts.SyntaxKind.ExpressionWithTypeArguments,
      nodeReader(ts.isExpressionWithTypeArguments, (expression) =>
        this.context.trace(expression.expression)
      ),
    ],
    [
      ts.SyntaxKind.SpreadElement,
      nodeReader(ts.isSpreadElement, (expression) =>
        this.context.projected(
          this.context.trace(expression.expression),
          this.context.elementStep(expression.expression)
        )
      ),
    ],
    [
      ts.SyntaxKind.CallExpression,
      nodeReader(ts.isCallExpression, (call) => this.context.callRoots(call)),
    ],
    [
      ts.SyntaxKind.TaggedTemplateExpression,
      nodeReader(ts.isTaggedTemplateExpression, (call) =>
        this.context.callRoots(call)
      ),
    ],
    [
      ts.SyntaxKind.NewExpression,
      nodeReader(ts.isNewExpression, (call) =>
        this.context.constructionRoots(call)
      ),
    ],
    [
      ts.SyntaxKind.PropertyAccessExpression,
      nodeReader(ts.isPropertyAccessExpression, (expression) =>
        this.memberRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.ElementAccessExpression,
      nodeReader(ts.isElementAccessExpression, (expression) =>
        this.memberRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.ObjectLiteralExpression,
      nodeReader(ts.isObjectLiteralExpression, (expression) =>
        this.objectRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.ArrayLiteralExpression,
      nodeReader(ts.isArrayLiteralExpression, (expression) =>
        this.arrayRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.ConditionalExpression,
      nodeReader(ts.isConditionalExpression, (expression) =>
        [expression.whenTrue, expression.whenFalse].flatMap((branch) =>
          this.context.trace(branch)
        )
      ),
    ],
    [
      ts.SyntaxKind.BinaryExpression,
      nodeReader(ts.isBinaryExpression, (expression) =>
        this.binaryRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.TemplateExpression,
      nodeReader(ts.isTemplateExpression, (expression) =>
        this.concatenationRoots(
          expression,
          expression.templateSpans.map((span) => span.expression)
        )
      ),
    ],
    [
      ts.SyntaxKind.Identifier,
      nodeReader(ts.isIdentifier, (expression) =>
        this.identifierRoots(expression)
      ),
    ],
    [
      ts.SyntaxKind.ThisKeyword,
      (expression) => this.context.receivers.thisRoots(expression),
    ],
    [
      ts.SyntaxKind.SuperKeyword,
      (expression) => this.context.receivers.superRoots(expression),
    ],
  ]);
  traceExpression(expression: ts.Node): readonly Root[] {
    const reader = this.readers.get(expression.kind);
    return reader
      ? reader(expression)
      : unknownProvenance(
          expression,
          `unmodelled expression ${ts.SyntaxKind[expression.kind]}`
        );
  }
  constructor(context: ExpressionRootsContext) {
    this.context = context;
  }
  derivedThroughAssertion(
    expression: ts.Expression | undefined,
    visited = new Set<ts.Node>()
  ): boolean {
    let unwrapped = expression;
    while (
      unwrapped &&
      isWrapperExpression(unwrapped) &&
      unwrapped.expression
    ) {
      unwrapped = unwrapped.expression;
    }
    if (!unwrapped || visited.has(unwrapped)) {
      return false;
    }
    visited.add(unwrapped);
    if (this.context.declarations.passesAssertion(expression)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return this.derivedThroughAssertion(unwrapped.expression, visited);
    }
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    return (
      this.context.checker.getSymbolAtLocation(unwrapped)?.declarations ?? []
    ).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        this.derivedThroughAssertion(declaration.initializer, visited)
    );
  }
  namespaceMemberRoots(
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression
  ): readonly Root[] | null {
    if (!ts.isPropertyAccessExpression(expression)) {
      return null;
    }
    const receiver = aliasTarget(
      this.context.checker,
      this.context.checker.getSymbolAtLocation(expression.expression)
    );
    if (!receiver || !(receiver.flags & ts.SymbolFlags.Module)) {
      return null;
    }
    const member = aliasTarget(
      this.context.checker,
      this.context.checker.getSymbolAtLocation(expression.name)
    );
    return (member?.declarations ?? []).flatMap((declaration) =>
      this.context.bindingRoots(declaration, expression)
    );
  }
  memberRoots(
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression
  ): readonly Root[] {
    const namespaced = this.namespaceMemberRoots(expression);
    if (namespaced) {
      return namespaced;
    }
    const keys = this.context.contracts.accessKeys(expression);
    const receiver = expression.expression;
    const step = this.context.accessStep(
      receiver,
      keys,
      keys === null || [...keys].every((key) => /^\d+$/u.test(key)),
      () =>
        this.context.sources.memberSourceRoots(
          expression,
          this.context.checker.getTypeAtLocation(receiver)
        )
    );
    return this.context.projected(this.context.trace(receiver), step);
  }
  writtenKeys = (property: ts.ObjectLiteralElementLike) => {
    if (!ts.isSpreadAssignment(property)) {
      const keys = this.context.contracts.propertyKeys(property);
      return keys?.size === 1 ? [...keys] : [];
    }
    const spread = this.context.checker
      .getTypeAtLocation(property.expression)
      .getNonNullableType();
    return this.context.checker
      .getPropertiesOfType(spread)
      .filter((member) => !(member.flags & ts.SymbolFlags.Optional))
      .map((member) => member.name);
  };
  propertyRoots(property: ts.ObjectLiteralElementLike): readonly Root[] {
    if (ts.isSpreadAssignment(property)) {
      return this.context.trace(property.expression);
    }
    let inherited: readonly Root[];
    if (ts.isPropertyAssignment(property)) {
      inherited = this.context.trace(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const shorthandDeclarations =
        this.context.checker.getShorthandAssignmentValueSymbol(property)
          ?.declarations ?? [];
      inherited = shorthandDeclarations.flatMap((declaration) =>
        this.context.bindingRoots(declaration, property)
      );
    } else {
      return [];
    }
    const keys = this.context.contracts.propertyKeys(property);
    if (!keys) {
      return inherited;
    }
    return [...keys].flatMap((key) =>
      inherited.map((root) =>
        this.context.algebra.prefixed(root, key, property)
      )
    );
  }
  objectRoots(expression: ts.ObjectLiteralExpression): readonly Root[] {
    const written = expression.properties.map(this.writtenKeys);
    return expression.properties.flatMap((property, position) =>
      this.context.algebra.overridden(
        this.propertyRoots(property),
        new Set(written.slice(position + 1).flat())
      )
    );
  }
  arrayRoots(expression: ts.ArrayLiteralExpression): readonly Root[] {
    return expression.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) {
        return this.context.trace(element.expression);
      }
      if (ts.isOmittedExpression(element)) {
        return [];
      }
      return this.context
        .trace(element)
        .map((root) => this.context.algebra.prefixed(root, ELEMENT, element));
    });
  }
  assertionRoots(expression: ts.AssertionExpression): readonly Root[] {
    const roots = this.context.trace(expression.expression);
    return isAssertionChain(expression)
      ? roots.map((root) =>
          this.context.algebra.flagged(root, { castChain: true })
        )
      : this.context.withClaim(
          roots,
          this.context.checker.getTypeFromTypeNode(expression.type),
          expression,
          { allowTypeParameter: true }
        );
  }
  identifierRoots(expression: ts.Identifier): readonly Root[] {
    const target = aliasTarget(
      this.context.checker,
      this.context.checker.getSymbolAtLocation(expression)
    );
    return (target?.declarations ?? []).flatMap((declaration) =>
      this.context.bindingRoots(declaration, expression)
    );
  }
  concatenationRoots(
    expression: ts.Node,
    operands: readonly ts.Expression[]
  ): readonly Root[] {
    const produced = this.context.checker.getTypeAtLocation(expression);
    if (!(produced.flags & ts.TypeFlags.StringLike)) {
      return [];
    }
    return operands.flatMap((operand) =>
      this.context.stringified(this.context.trace(operand))
    );
  }
  binaryRoots(expression: ts.BinaryExpression): readonly Root[] {
    const disposition =
      binaryDispositions.get(expression.operatorToken.kind) ?? "safe";
    if (disposition === "safe") {
      return [];
    }
    if (disposition === "right") {
      return this.context.trace(expression.right);
    }
    if (disposition === "concatenation") {
      return this.concatenationRoots(expression, [
        expression.left,
        expression.right,
      ]);
    }
    return [expression.left, expression.right].flatMap((branch) =>
      this.context.trace(branch)
    );
  }
}
