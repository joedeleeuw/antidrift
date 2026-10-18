import ts from "typescript";

import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import { unwrapExpression } from "./boundary-syntax.ts";
import { broad } from "./boundary-types.ts";
import type { CarrierPath } from "./carrier-paths.ts";
import { excluded } from "./decision-cases.ts";
import { FrameworkRoots } from "./framework-roots.ts";
import type { ConcreteRoot, Root } from "./root-domain.ts";
import { rootCases } from "./source-cases.ts";

type SourcesContext = {
  readonly checker: ts.TypeChecker;
  readonly declarations: BoundaryDeclarations;
  readonly hasRoots: (expression: ts.Expression) => boolean;
};

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

type SourceCall = ts.CallExpression | ts.NewExpression;

const writeOperators: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

class BoundarySources {
  readonly #checker: ts.TypeChecker;
  readonly #declarations: BoundaryDeclarations;
  readonly #hasRoots: SourcesContext["hasRoots"];
  readonly #frameworks: FrameworkRoots;
  readonly #writesBySource = new WeakMap<
    ts.SourceFile,
    Map<ts.Symbol, ts.BinaryExpression[]>
  >();
  readonly #callersBySource = new WeakMap<
    ts.SourceFile,
    Map<ts.Node, SourceCall[]>
  >();

  constructor(context: SourcesContext) {
    this.#checker = context.checker;
    this.#declarations = context.declarations;
    this.#hasRoots = context.hasRoots;
    this.#frameworks = new FrameworkRoots(
      context.checker,
      context.declarations.origin
    );
  }

  writes(source: ts.SourceFile) {
    const cached = this.#writesBySource.get(source);
    if (cached) {
      return cached;
    }
    const assignments = new Map<ts.Symbol, ts.BinaryExpression[]>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        writeOperators.has(node.operatorToken.kind)
      ) {
        const symbol = this.#checker.getSymbolAtLocation(node.left);
        if (symbol) {
          const entries = assignments.get(symbol) ?? [];
          entries.push(node);
          assignments.set(symbol, entries);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    this.#writesBySource.set(source, assignments);
    return assignments;
  }

  callersOf(declaration: ts.Node): readonly SourceCall[] {
    const source = declaration.getSourceFile();
    let callers = this.#callersBySource.get(source);
    if (!callers) {
      callers = new Map<ts.Node, SourceCall[]>();
      for (const call of this.#declarations.callsInSource(source)) {
        const callee = this.#checker.getResolvedSignature(call)?.declaration;
        if (callee) {
          const entries = callers.get(callee) ?? [];
          entries.push(call);
          callers.set(callee, entries);
        }
      }
      this.#callersBySource.set(source, callers);
    }
    return callers.get(declaration) ?? [];
  }

  exportedParameterRoots(
    parameter: ts.ParameterDeclaration,
    declared: ts.Type
  ): ConcreteRoot[] {
    const members = declared.isUnion() ? declared.types : [declared];
    const declares = (flag: ts.TypeFlags) =>
      members.some((member) => (member.flags & flag) !== 0);
    const row = rootCases.find(
      (candidate) =>
        candidate.exported &&
        (candidate.parameter === "unknown"
          ? declares(ts.TypeFlags.Unknown)
          : declares(ts.TypeFlags.String))
    );
    if (!row) {
      return [];
    }
    const { kind, activation } = row;
    return [
      {
        kind,
        root: parameter,
        declaration: parameter,
        activation,
        opaque: !activation,
      },
    ];
  }

  frameworkRoot(expression: ts.Expression) {
    const carrier = this.#declarations.carrierPath(expression);
    if (!carrier || carrier.deserialized) {
      return null;
    }
    return this.#frameworks.rootOf(carrier, expression);
  }

  localReceiver(
    expression: ts.Node,
    visited = new Set<ts.Node>()
  ): ts.NewExpression | null {
    if (visited.has(expression)) {
      return null;
    }
    visited.add(expression);
    if (ts.isNewExpression(expression)) {
      return expression;
    }
    if (!ts.isIdentifier(expression)) {
      return null;
    }
    for (const declaration of this.#checker.getSymbolAtLocation(expression)
      ?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return this.localReceiver(declaration.initializer, visited);
      }
    }
    return null;
  }

  localString(
    expression: ts.Expression | undefined,
    visited = new Set<ts.Node>()
  ): boolean {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) {
      return false;
    }
    visited.add(unwrapped);
    if (
      ts.isStringLiteral(unwrapped) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped)
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return unwrapped.elements.every((element) =>
        this.localString(element, new Set(visited))
      );
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return unwrapped.templateSpans.every((span) =>
        this.localString(span.expression, new Set(visited))
      );
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return (
        this.localString(unwrapped.left, new Set(visited)) &&
        this.localString(unwrapped.right, new Set(visited))
      );
    }
    if (ts.isCallExpression(unwrapped)) {
      return this.#localCallString(unwrapped, visited);
    }
    return (
      ts.isIdentifier(unwrapped) &&
      this.#localIdentifierString(unwrapped, visited)
    );
  }

  incompleteCause(expression: ts.Expression | undefined): string {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped) {
      return "unresolved-provenance";
    }
    if (ts.isCallExpression(unwrapped)) {
      return "untracked-call-return";
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return "untracked-member-or-element";
    }
    if (!ts.isIdentifier(unwrapped)) {
      return "unresolved-provenance";
    }
    const symbol = this.#checker.getSymbolAtLocation(unwrapped);
    const assignments = this.writes(unwrapped.getSourceFile());
    if (symbol && assignments.get(symbol)?.length) {
      return "cross-callback-mutation";
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isParameter(declaration)) {
        return "untracked-parameter";
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return this.incompleteCause(declaration.initializer);
      }
    }
    return "unresolved-provenance";
  }

  memberSourceRoots(expression: MemberAccess, receiverType: ts.Type): Root[] {
    const request = this.frameworkRoot(expression);
    if (request) {
      return [request];
    }
    const symbol = this.#checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression
    );
    for (const declaration of symbol?.declarations ?? []) {
      const source = this.#declarations.platformSource(declaration);
      if (source) {
        return this.#declaredMemberRoots(expression, receiverType, {
          declaration,
          source,
        });
      }
    }
    for (const index of this.#checker.getIndexInfosOfType(receiverType)) {
      const source =
        index.declaration &&
        this.#declarations.platformSource(index.declaration);
      if (index.declaration && source) {
        return [
          {
            kind: source.kind,
            root: expression,
            declaration: index.declaration,
            opaque: Boolean(source.opaque),
          },
        ];
      }
    }
    return this.#unresolvedReceiverRoot(expression);
  }

  bindingSourceRoots(
    element: ts.Node,
    receiverType: ts.Type,
    keys: ReadonlySet<string> | null,
    carrier: CarrierPath | null | undefined
  ): Root[] {
    const request = carrier && this.#frameworks.rootOf(carrier, element);
    if (request) {
      return [request];
    }
    if (!keys) {
      return [];
    }
    for (const key of keys) {
      const property = this.#checker.getPropertyOfType(
        receiverType.getNonNullableType(),
        key
      );
      for (const declaration of property?.declarations ?? []) {
        const source = this.#declarations.platformSource(declaration);
        if (source) {
          const opaque = Boolean(
            source.opaque || broad(this.#checker.getTypeAtLocation(element))
          );
          return [{ kind: source.kind, root: element, declaration, opaque }];
        }
      }
    }
    return [];
  }

  #declaredMemberRoots(
    expression: MemberAccess,
    receiverType: ts.Type,
    member: {
      readonly declaration: ts.Declaration;
      readonly source: NonNullable<
        ReturnType<BoundaryDeclarations["platformSource"]>
      >;
    }
  ): Root[] {
    const { declaration, source } = member;
    const contract =
      ts.hasType(declaration) && declaration.type
        ? this.#checker.getTypeFromTypeNode(declaration.type)
        : undefined;
    const receiverArguments = this.#checker.getTypeArguments(
      receiverType.getNonNullableType()
    );
    if (
      excluded({
        local: this.localReceiver(expression.expression),
        narrowed:
          !source.opaque &&
          contract !== undefined &&
          (contract.flags & ts.TypeFlags.TypeParameter) !== 0 &&
          receiverArguments.length > 0 &&
          !receiverArguments.some(broad),
      })
    ) {
      return [];
    }
    const memberOutput = this.#checker.getAwaitedType(
      this.#checker.getTypeAtLocation(expression)
    );
    const opaque = Boolean(source.opaque || broad(memberOutput));
    return [{ kind: source.kind, root: expression, declaration, opaque }];
  }

  #localCallString(call: ts.CallExpression, visited: Set<ts.Node>): boolean {
    const construction =
      ts.isPropertyAccessExpression(call.expression) &&
      this.localReceiver(call.expression.expression);
    if (construction) {
      return (construction.arguments ?? []).every((argument) =>
        this.localString(argument, new Set(visited))
      );
    }
    const declaration = this.#checker.getResolvedSignature(call)?.declaration;
    const [subject] = call.arguments;
    return Boolean(
      declaration &&
      this.#declarations.origin(declaration, call) === "platform" &&
      ts.isNamedDeclaration(declaration) &&
      declaration.name.getText(declaration.getSourceFile()) === "stringify" &&
      subject &&
      !this.#hasRoots(subject)
    );
  }

  #localIdentifierString(
    identifier: ts.Identifier,
    visited: Set<ts.Node>
  ): boolean {
    const symbol = this.#checker.getSymbolAtLocation(identifier);
    const assignments = this.writes(identifier.getSourceFile());
    if (symbol && assignments.get(symbol)?.length) {
      return false;
    }
    return (symbol?.declarations ?? []).some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return this.localString(declaration.initializer, visited);
      }
      if (
        !ts.isParameter(declaration) ||
        this.#declarations.exported(declaration.parent)
      ) {
        return false;
      }
      const index = declaration.parent.parameters.indexOf(declaration);
      const calls = this.callersOf(declaration.parent);
      return (
        calls.length > 0 &&
        calls.every((call) =>
          this.localString(call.arguments?.[index], new Set(visited))
        )
      );
    });
  }

  #unresolvedReceiverRoot(expression: MemberAccess): ConcreteRoot[] {
    let receiver = unwrapExpression(expression.expression);
    while (
      ts.isPropertyAccessExpression(receiver) ||
      ts.isElementAccessExpression(receiver)
    ) {
      receiver = unwrapExpression(receiver.expression);
    }
    if (
      !ts.isIdentifier(receiver) ||
      this.#checker.getSymbolAtLocation(receiver)
    ) {
      return [];
    }
    return [
      {
        kind: "unresolved-declaration",
        root: expression,
        declaration: null,
        opaque: true,
        incomplete: `unresolved declaration of '${receiver.text}'`,
      },
    ];
  }
}

export function boundarySources(context: SourcesContext) {
  const sources = new BoundarySources(context);
  return {
    bindingSourceRoots: sources.bindingSourceRoots.bind(sources),
    callersOf: sources.callersOf.bind(sources),
    exportedParameterRoots: sources.exportedParameterRoots.bind(sources),
    frameworkRoot: sources.frameworkRoot.bind(sources),
    incompleteCause: sources.incompleteCause.bind(sources),
    localReceiver: sources.localReceiver.bind(sources),
    localString: sources.localString.bind(sources),
    memberSourceRoots: sources.memberSourceRoots.bind(sources),
    writes: sources.writes.bind(sources),
  };
}
