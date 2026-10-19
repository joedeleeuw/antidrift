import ts from "typescript";
import { assertionKinds } from "./boundary-contracts.ts";
import { broad } from "./boundary-types.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import { enclosingFunction, isAssertionChain } from "./boundary-syntax.ts";
import type { Root } from "./root-domain.ts";
import { nodeReader } from "../kernel/typescript-internals.ts";
import { SinkProof } from "./sink-proof.ts";
import type { SinkContext } from "./sink-proof.ts";

class SinkDispatch {
  readonly context: SinkContext;
  readonly proof: SinkProof;
  readonly sinks = new Map<ts.SyntaxKind, (node: ts.Node) => Root[]>([
    [
      ts.SyntaxKind.AsExpression,
      nodeReader(ts.isAsExpression, (node) => this.assertionSink(node)),
    ],
    [
      ts.SyntaxKind.TypeAssertionExpression,
      nodeReader(ts.isTypeAssertionExpression, (node) =>
        this.assertionSink(node)
      ),
    ],
    [
      ts.SyntaxKind.VariableDeclaration,
      nodeReader(ts.isVariableDeclaration, (node) =>
        this.declarationSink(node)
      ),
    ],
    [
      ts.SyntaxKind.BinaryExpression,
      nodeReader(ts.isBinaryExpression, (node) => this.assignmentSink(node)),
    ],
    [
      ts.SyntaxKind.ReturnStatement,
      nodeReader(ts.isReturnStatement, (node) => this.returnSink(node)),
    ],
    [
      ts.SyntaxKind.CallExpression,
      nodeReader(ts.isCallExpression, (node) => this.typeArgumentSink(node)),
    ],
  ]);
  constructor(context: SinkContext) {
    this.context = context;
    this.proof = new SinkProof(context);
  }
  uncheckedAt(node: ts.Node) {
    const sink = this.sinks.get(node.kind);
    return sink ? sink(node) : [];
  }
  argumentType(call: ts.CallExpression | ts.NewExpression, index: number) {
    const signature = this.context.checker.getResolvedSignature(call);
    if (!signature) {
      return null;
    }
    const parameter =
      signature.parameters[Math.min(index, signature.parameters.length - 1)];
    if (!parameter) {
      return null;
    }
    const instantiated = this.context.checker.getTypeOfSymbolAtLocation(
      parameter,
      call
    );
    const declaredParameter = parameter.valueDeclaration;
    const declared =
      declaredParameter &&
      ts.isParameter(declaredParameter) &&
      declaredParameter.type
        ? this.context.checker.getTypeFromTypeNode(declaredParameter.type)
        : undefined;
    const contract =
      broad(instantiated) &&
      declared &&
      (declared.flags & ts.TypeFlags.TypeParameter) !== 0
        ? (this.context.checker.getBaseConstraintOfType(declared) ??
          instantiated)
        : instantiated;
    if (
      !declaredParameter ||
      !ts.isParameter(declaredParameter) ||
      !declaredParameter.dotDotDotToken
    ) {
      return contract;
    }
    if (this.context.checker.isTupleType(contract)) {
      return this.context.checker.getTypeArguments(contract)[
        index - signature.parameters.length + 1
      ];
    }
    return this.context.checker.getIndexTypeOfType(
      contract,
      ts.IndexKind.Number
    );
  }
  ownedByCastChain(expression: ts.Expression | undefined) {
    let current = expression;
    while (
      current &&
      (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current))
    ) {
      current = current.expression;
    }
    return current ? isAssertionChain(current) : false;
  }
  observeSink(
    sinkKind: string,
    sinkNode: ts.Node,
    expression: ts.Expression,
    evaluate: () => Root[]
  ): Root[] {
    if (!this.context.observer.enabled) {
      return evaluate();
    }
    const decision = this.context.observer.beginSink(
      sinkKind,
      sinkNode,
      expression
    );
    return this.context.observer.finishSink(decision, evaluate());
  }
  assertionSink(assertion: ts.AssertionExpression): Root[] {
    if (
      isAssertionChain(assertion) ||
      assertionKinds.has(assertion.parent.kind)
    ) {
      return [];
    }
    return this.observeSink(
      boundaryObservations.sinks.assertion,
      assertion,
      assertion.expression,
      () =>
        this.proof.unchecked(
          assertion.expression,
          this.context.checker.getTypeAtLocation(assertion),
          {
            allowTypeParameter: true,
            claimNode: assertion,
          }
        )
    );
  }
  declarationSink(declaration: ts.VariableDeclaration): Root[] {
    const { initializer, type } = declaration;
    if (!initializer || this.ownedByCastChain(initializer)) {
      return [];
    }
    if (type) {
      return this.observeSink(
        boundaryObservations.sinks.declaration,
        declaration,
        initializer,
        () =>
          this.proof.unchecked(
            initializer,
            this.context.checker.getTypeFromTypeNode(type),
            { claimNode: declaration }
          )
      );
    }
    if (
      ts.isObjectBindingPattern(declaration.name) ||
      ts.isArrayBindingPattern(declaration.name)
    ) {
      return this.observeSink(
        boundaryObservations.sinks.declaration,
        declaration,
        initializer,
        () => this.proof.unchecked(initializer, null, { opaqueOnly: true })
      );
    }
    return [];
  }
  assignmentSink(assignment: ts.BinaryExpression): Root[] {
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      this.ownedByCastChain(assignment.right)
    ) {
      return [];
    }
    return this.observeSink(
      boundaryObservations.sinks.assignment,
      assignment,
      assignment.right,
      () =>
        this.proof.unchecked(
          assignment.right,
          this.context.checker.getTypeAtLocation(assignment.left)
        )
    );
  }
  returnSink(statement: ts.ReturnStatement): Root[] {
    const { expression } = statement;
    if (!expression || this.ownedByCastChain(expression)) {
      return [];
    }
    const owner = enclosingFunction(statement);
    const contract = owner?.type;
    if (!owner || !contract) {
      return [];
    }
    return this.observeSink(
      boundaryObservations.sinks.return,
      statement,
      expression,
      () =>
        this.proof.unchecked(
          expression,
          this.context.checker.getAwaitedType(
            this.context.checker.getTypeFromTypeNode(contract)
          ),
          { claimNode: owner }
        )
    );
  }
  typeArgumentSink(call: ts.CallExpression): Root[] {
    const typeArgument = call.typeArguments?.[0];
    if (!typeArgument) {
      return [];
    }
    return this.observeSink(
      boundaryObservations.sinks.typeArgument,
      call,
      call,
      () => {
        if (
          !this.context.checker.getResolvedSignature(call) ||
          this.context.decode(call) ||
          !this.context.trace(call).some((root) => root.root === call)
        ) {
          return [];
        }
        return this.proof.unchecked(
          call,
          this.context.checker.getTypeFromTypeNode(typeArgument),
          {
            allowTypeParameter: true,
            claimNode: call,
          }
        );
      }
    );
  }
  uncheckedArgument(argument: ts.Expression): Root[] {
    const call = argument.parent;
    if (
      !(ts.isCallExpression(call) || ts.isNewExpression(call)) ||
      !call.arguments ||
      !call.arguments.includes(argument) ||
      this.ownedByCastChain(argument)
    ) {
      return [];
    }
    const argumentsAtCall = call.arguments;
    return this.observeSink(
      boundaryObservations.sinks.argument,
      argument,
      argument,
      () => {
        if (
          !this.context.checker.getResolvedSignature(call) ||
          (ts.isCallExpression(call) && this.context.decode(call))
        ) {
          return [];
        }
        return this.proof.unchecked(
          argument,
          this.argumentType(call, argumentsAtCall.indexOf(argument))
        );
      }
    );
  }
}
export function boundarySinks(context: SinkContext) {
  const dispatch = new SinkDispatch(context);
  return {
    uncheckedAt: dispatch.uncheckedAt.bind(dispatch),
    uncheckedArgument: dispatch.uncheckedArgument.bind(dispatch),
  };
}
