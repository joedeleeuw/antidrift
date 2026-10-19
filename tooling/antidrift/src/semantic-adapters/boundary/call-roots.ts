import ts from "typescript";
import { ELEMENT, unresolvedType } from "./boundary-contracts.ts";
import type { Root } from "./root-domain.ts";
import { unknownProvenance } from "./root-domain.ts";
import { memoizedRoots } from "./trace-context.ts";
import type { TraceContext, TraceCall } from "./trace-context.ts";
import { excluded } from "./decision-cases.ts";
import { aliasTarget } from "../provenance/symbol-provenance.ts";
import { callbackReturns, unwrapExpression } from "./boundary-syntax.ts";

type CallRootsContext = Pick<
  TraceContext,
  | "checker"
  | "declarations"
  | "algebra"
  | "sources"
  | "trace"
  | "summary"
  | "withClaim"
  | "forwarding"
>;
export class CallRoots {
  readonly context: CallRootsContext;
  constructor(context: CallRootsContext) {
    this.context = context;
  }
  callResultContract(
    contract: ts.Type | null | undefined
  ): ts.Type | null | undefined {
    if (!contract || unresolvedType(contract)) {
      return contract;
    }
    const signature = contract.getNonNullableType().getCallSignatures()[0];
    return signature
      ? this.context.checker.getAwaitedType(
          this.context.checker.getReturnTypeOfSignature(signature)
        )
      : null;
  }
  untypedCalleeRoots(call: TraceCall, callee: ts.Expression): readonly Root[] {
    return this.context.algebra
      .filtered(this.context.trace(callee), "opaqueOrIncomplete")
      .map((root) => {
        const resultRoot = this.context.algebra.flagged(root, {
          root: call,
          path: undefined,
          overrides: undefined,
        });
        return resultRoot.claim
          ? {
              ...resultRoot,
              claim: {
                ...resultRoot.claim,
                contract: this.callResultContract(resultRoot.claim.contract),
              },
            }
          : resultRoot;
      });
  }
  decoderSubject(argument: ts.Expression) {
    const unwrapped = unwrapExpression(argument);
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    return (
      this.context.checker.getSymbolAtLocation(unwrapped)?.declarations ?? []
    ).some((declaration) => {
      if (!ts.isParameter(declaration)) {
        return false;
      }
      const owner = declaration.parent;
      const evidence = this.context.declarations.signatureDecode(
        this.context.checker.getSignatureFromDeclaration(owner),
        declaration
      );
      return evidence?.parameter === owner.parameters.indexOf(declaration);
    });
  }
  deserializerRoots(
    call: TraceCall,
    argument: ts.Expression | null | undefined,
    source: NonNullable<
      ReturnType<TraceContext["declarations"]["platformSource"]>
    >,
    declaration: NonNullable<ts.Signature["declaration"]>
  ): readonly Root[] {
    if (!argument) {
      return [];
    }
    const { kind } = source;
    return this.context.algebra.captured(this.context.trace(argument), {
      kind,
      call,
      declaration,
      opaque: true,
      whenEmpty: () => {
        if (
          excluded({ local: this.context.sources.localString(argument) }) ||
          this.decoderSubject(argument)
        ) {
          return [];
        }
        return [
          {
            kind,
            root: call,
            declaration,
            opaque: true,
            incomplete: this.context.sources.incompleteCause(argument),
          },
        ];
      },
    });
  }
  platformCallRoots(
    call: TraceCall,
    callee: ts.Expression,
    source: NonNullable<
      ReturnType<TraceContext["declarations"]["platformSource"]>
    >,
    declaration: NonNullable<ts.Signature["declaration"]>
  ): readonly Root[] {
    const construction =
      ts.isPropertyAccessExpression(callee) &&
      this.context.sources.localReceiver(callee.expression);
    const opaque = this.context.forwarding.callOpaque(
      declaration,
      source.opaque,
      call
    );
    if (construction) {
      return (construction.arguments ?? []).flatMap((argument) =>
        this.context.algebra.captured(this.context.trace(argument), {
          kind: source.kind,
          call,
          declaration,
          opaque,
          whenEmpty: () => [],
        })
      );
    }
    return this.typeArgumentClaim(call, [
      { kind: source.kind, root: call, declaration, opaque },
    ]);
  }
  typeArgumentClaim(call: TraceCall, roots: readonly Root[]): readonly Root[] {
    const typeArgument = call.typeArguments?.[0];
    return typeArgument
      ? this.context.withClaim(
          roots,
          this.context.checker.getTypeFromTypeNode(typeArgument),
          call,
          {
            allowTypeParameter: true,
          }
        )
      : roots;
  }
  argumentBindings(
    declaredParameters: readonly ts.ParameterDeclaration[],
    callArguments: readonly (ts.Expression | null)[]
  ): Map<ts.ParameterDeclaration, () => readonly Root[]> {
    const bound = new Map<ts.ParameterDeclaration, () => readonly Root[]>();
    for (const [index, parameter] of declaredParameters.entries()) {
      if (parameter.dotDotDotToken) {
        bound.set(
          parameter,
          memoizedRoots(() =>
            callArguments
              .slice(index)
              .flatMap((argument) =>
                argument
                  ? this.context
                      .trace(argument)
                      .map((root) =>
                        this.context.algebra.prefixed(root, ELEMENT, argument)
                      )
                  : []
              )
          )
        );
        continue;
      }
      const argument = callArguments[index] ?? parameter.initializer;
      bound.set(
        parameter,
        memoizedRoots(() => (argument ? this.context.trace(argument) : []))
      );
    }
    return bound;
  }
  returnRoots(declaration: ts.SignatureDeclaration): readonly Root[] {
    return this.context.withClaim(
      callbackReturns(declaration).flatMap((expression) =>
        this.context.trace(expression)
      ),
      declaration.type &&
        this.context.checker.getAwaitedType(
          this.context.checker.getTypeFromTypeNode(declaration.type)
        ),
      declaration
    );
  }
  calleeImplementation(
    callee: ts.Expression,
    declaration: NonNullable<ts.Signature["declaration"]>
  ): ts.FunctionLikeDeclaration | null {
    if (ts.isFunctionLikeDeclaration(declaration) && declaration.body) {
      return declaration;
    }
    const target = aliasTarget(
      this.context.checker,
      this.context.checker.getSymbolAtLocation(callee)
    );
    for (const node of [declaration.parent, ...(target?.declarations ?? [])]) {
      const candidate = ts.isVariableDeclaration(node)
        ? node.initializer
        : node;
      if (
        candidate &&
        ts.isFunctionLikeDeclaration(candidate) &&
        candidate.body
      ) {
        return candidate;
      }
    }
    return null;
  }
  callArgumentsOf(call: TraceCall): readonly (ts.Expression | null)[] {
    if (ts.isTaggedTemplateExpression(call)) {
      const spans = ts.isTemplateExpression(call.template)
        ? call.template.templateSpans.map((span) => span.expression)
        : [];
      return [null, ...spans];
    }
    return [...(call.arguments ?? [])];
  }
  decodedRoots(
    evidence: NonNullable<ReturnType<TraceContext["declarations"]["decode"]>>
  ): readonly Root[] {
    const settled = evidence.kind === "result";
    return this.context.trace(evidence.input).map((root) =>
      this.context.algebra.flagged(root, {
        decoded: !settled,
        pending: settled ? evidence : undefined,
        claim: undefined,
        incomplete: undefined,
        ...(settled ? { opaque: false } : {}),
      })
    );
  }
  stringified(roots: readonly Root[]): readonly Root[] {
    return roots.map((root) =>
      !root.parameter && root.incomplete
        ? root
        : this.context.algebra.flagged(root, {
            opaque: false,
            activation: "serialized-input",
          })
    );
  }
  callRoots(
    call: ts.CallExpression | ts.TaggedTemplateExpression
  ): readonly Root[] {
    const callee = ts.isTaggedTemplateExpression(call)
      ? call.tag
      : call.expression;
    const callArguments = this.callArgumentsOf(call);
    const signature = this.context.checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!declaration) {
      return this.untypedCalleeRoots(call, callee);
    }
    const source = this.context.declarations.platformSource(declaration);
    if (source?.requiresProvenance) {
      return this.deserializerRoots(
        call,
        callArguments[source.argument],
        source,
        declaration
      );
    }
    if (source) {
      return this.platformCallRoots(call, callee, source, declaration);
    }
    const evidence = ts.isCallExpression(call)
      ? this.context.declarations.decode(call)
      : null;
    if (evidence) {
      return this.decodedRoots(evidence);
    }
    const request = this.context.sources.frameworkRoot(callee);
    if (request) {
      return this.typeArgumentClaim(call, [
        {
          ...request,
          root: call,
          opaque: this.context.forwarding.callOpaque(declaration, false, call),
        },
      ]);
    }
    const implementation = this.calleeImplementation(callee, declaration);
    if (
      implementation &&
      this.context.declarations.origin(implementation, call) === null
    ) {
      return this.context.algebra.substituteAll(
        this.context.summary(implementation),
        this.argumentBindings(implementation.parameters, callArguments)
      );
    }
    return this.forwardedCallRoots(call, declaration, callArguments);
  }
  forwardedCallRoots(
    call: ts.CallExpression | ts.TaggedTemplateExpression,
    declaration: NonNullable<ts.Signature["declaration"]>,
    callArguments: ReturnType<CallRoots["callArgumentsOf"]>
  ): readonly Root[] {
    const declared =
      this.context.checker.getSignatureFromDeclaration(declaration);
    if (!declared) {
      return [];
    }
    const candidate = this.context.declarations.signatureForm(declared);
    const forwarded = this.context.forwarding.forwardedRoots(call, declared);
    const argument =
      candidate?.parameter === undefined
        ? undefined
        : callArguments[candidate.parameter];
    if (candidate && argument) {
      let stringProjection = false;
      if (this.context.declarations.origin(declaration, call) === "platform") {
        if (!candidate.output) {
          throw new TypeError(
            "Boundary decoder signature has no awaited output"
          );
        }
        stringProjection = Boolean(
          candidate.output.flags & ts.TypeFlags.StringLike
        );
      }
      const subject = this.context.trace(argument);
      forwarded.push(
        ...(stringProjection
          ? this.stringified(subject)
          : subject.map((root) =>
              this.context.algebra.flagged(root, { opaque: true })
            ))
      );
    }
    const output = this.context.checker.getReturnTypeOfSignature(declared);
    if (
      excluded({
        genericWithoutInput:
          Boolean(output.flags & ts.TypeFlags.TypeParameter) &&
          !forwarded.length,
        unresolved: !forwarded.length,
      })
    ) {
      return [];
    }
    return forwarded;
  }

  constructionRoots(expression: ts.NewExpression): readonly Root[] {
    const signature = this.context.checker.getResolvedSignature(expression);
    const declaration = signature?.declaration;
    const source =
      declaration && this.context.declarations.platformSource(declaration);
    if (source) {
      return this.typeArgumentClaim(expression, [
        {
          kind: source.kind,
          root: expression,
          declaration,
          opaque: Boolean(source.opaque),
        },
      ]);
    }
    const classDeclaration =
      declaration &&
      (ts.isClassLike(declaration) ? declaration : declaration.parent);
    if (
      classDeclaration &&
      ts.isClassLike(classDeclaration) &&
      this.context.declarations.origin(classDeclaration, expression) === null
    ) {
      const constructor = classDeclaration.members.find(
        ts.isConstructorDeclaration
      );
      return this.context.algebra.substituteAll(
        this.context.summary(classDeclaration),
        this.argumentBindings(constructor?.parameters ?? [], [
          ...(expression.arguments ?? []),
        ])
      );
    }
    if (!signature) {
      return unknownProvenance(expression, "construction without a signature");
    }
    return this.context.forwarding.forwardedRoots(expression, signature);
  }
}
