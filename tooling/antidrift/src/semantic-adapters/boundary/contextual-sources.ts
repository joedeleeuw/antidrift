import ts from "typescript";

import { ELEMENT } from "./boundary-contracts.ts";
import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import { callbackReturns, unwrapExpression } from "./boundary-syntax.ts";
import { broad } from "./boundary-types.ts";
import type { HostCall } from "./callback-sites.ts";
import {
  CallbackDeclarations,
  callbackNodes,
  callbackUpstreamCandidates,
  hostCallOf,
} from "./callback-sites.ts";
import type { declarationSummaries } from "./declaration-summaries.ts";
import { nodeKey } from "./root-domain.ts";
import type { RootOperations } from "./root-algebra.ts";
import type { AccessStep, Root } from "./root-domain.ts";
import type {
  CollectionMatch,
  TypeParameterSet,
} from "./type-parameter-flow.ts";
import { TypeParameterFlow } from "./type-parameter-flow.ts";

type ContextualContext = {
  readonly checker: ts.TypeChecker;
  readonly declarations: BoundaryDeclarations;
  readonly trace: (expression: ts.Node | undefined) => readonly Root[];
  readonly summary: ReturnType<typeof declarationSummaries>["summary"];
  readonly fixpoint: ReturnType<typeof declarationSummaries>["fixpoint"];
  readonly substituteAll: RootOperations["substituteAll"];
  readonly prefixed: RootOperations["prefixed"];
  readonly projected: (
    roots: readonly Root[],
    step: AccessStep
  ) => readonly Root[];
  readonly elementStep: (expression: ts.Node) => AccessStep;
};

export type CallbackSite = {
  readonly argument: ts.Expression;
  readonly contract: ts.Type;
  readonly call: HostCall;
};

type UpstreamMatch = {
  readonly callback: ts.Node;
  readonly hostCall: HostCall;
  readonly declaration: NonNullable<ts.Signature["declaration"]>;
  readonly declaredSignature: ts.Signature;
  readonly targetParameters: TypeParameterSet;
  readonly targetContract: ts.Type | undefined;
};

type UpstreamArgument = {
  readonly match: UpstreamMatch;
  readonly callbackIndex: number;
  readonly otherIndex: number;
  readonly otherArgument: ts.Expression;
  readonly otherContract: ts.Type;
};

const NO_COLLECTION_MATCH: CollectionMatch = {
  shared: new Set(),
  sourceIsCollection: false,
};

export class ContextualSources {
  readonly #context: ContextualContext;
  readonly #checker: ts.TypeChecker;
  readonly #types: TypeParameterFlow;
  readonly #callbacks: CallbackDeclarations;

  constructor(context: ContextualContext) {
    this.#context = context;
    this.#checker = context.checker;
    this.#types = new TypeParameterFlow(context.checker);
    this.#callbacks = new CallbackDeclarations(
      context.checker,
      context.declarations.origin
    );
  }

  contextualParameterRoots(parameter: ts.ParameterDeclaration) {
    const callback = parameter.parent;
    if (!ts.isExpression(callback)) {
      return [];
    }
    const index = callback.parameters.indexOf(parameter);
    const contextual = this.#checker.getContextualType(callback);
    const hostCall = hostCallOf(callback);
    for (const signature of contextual
      ?.getNonNullableType()
      .getCallSignatures() ?? []) {
      const roots = this.#contextualSources(
        signature.parameters[index],
        callback,
        hostCall,
        parameter
      );
      if (roots.length) {
        return roots;
      }
    }
    return [];
  }

  callbackRoots(
    site: CallbackSite,
    callbackMatch: CollectionMatch,
    targetType: ts.Type | undefined
  ): readonly Root[] {
    const callbackRoots = this.#packIfCollection(
      this.#callbackResultRoots(site),
      site.call,
      callbackMatch,
      targetType
    );
    return this.unpackIfCollection(
      callbackRoots,
      site.argument,
      callbackMatch,
      targetType
    );
  }

  unpackIfCollection(
    roots: readonly Root[],
    sourceNode: ts.Node,
    match: CollectionMatch,
    targetType: ts.Type | undefined
  ): readonly Root[] {
    if (
      match.sourceIsCollection &&
      match.shared.size > 0 &&
      !this.#types.isCollectionOver(targetType, match.shared)
    ) {
      return this.#context.projected(
        roots,
        this.#context.elementStep(sourceNode)
      );
    }
    return roots;
  }

  #packIfCollection(
    roots: readonly Root[],
    call: ts.Node,
    match: CollectionMatch,
    targetType: ts.Type | undefined
  ): readonly Root[] {
    if (
      !match.sourceIsCollection &&
      match.shared.size > 0 &&
      this.#types.isCollectionOver(targetType, match.shared)
    ) {
      return roots.map((root) => this.#context.prefixed(root, ELEMENT, call));
    }
    return roots;
  }

  #matchedParentContextualRoots(match: UpstreamMatch): Root[] {
    const { hostCall, declaredSignature, targetParameters } = match;
    if (!ts.isCallExpression(hostCall.parent)) {
      return [];
    }
    const hostReturned =
      this.#checker.getReturnTypeOfSignature(declaredSignature);
    const parentContextual = this.#checker
      .getContextualType(hostCall)
      ?.getNonNullableType()
      .getCallSignatures()[0];
    if (!parentContextual) {
      return [];
    }
    const roots: Root[] = [];
    for (const returnedSig of hostReturned
      .getNonNullableType()
      .getCallSignatures()) {
      for (const [
        paramIndex,
        paramSymbol,
      ] of returnedSig.parameters.entries()) {
        const parentSubject = parentContextual.parameters[paramIndex];
        if (
          parentSubject &&
          this.#types.sharedTypeParameters(
            this.#checker.getTypeOfSymbol(paramSymbol),
            targetParameters
          ).size > 0
        ) {
          roots.push(
            ...this.#contextualSources(
              parentSubject,
              hostCall,
              hostCall.parent,
              hostCall
            )
          );
        }
      }
    }
    return roots;
  }

  #matchedUpstreamRoots(
    callback: ts.Node,
    hostCall: HostCall,
    targetParameters: TypeParameterSet,
    targetContract: ts.Type | undefined
  ): readonly Root[] | null {
    const declaration =
      this.#checker.getResolvedSignature(hostCall)?.declaration;
    const declaredSignature =
      declaration && this.#checker.getSignatureFromDeclaration(declaration);
    if (!declaration || !declaredSignature) {
      return null;
    }
    const match: UpstreamMatch = {
      callback,
      hostCall,
      declaration,
      declaredSignature,
      targetParameters,
      targetContract,
    };
    const receiverPart = this.#receiverUpstream(match);
    const argumentParts = this.#argumentUpstream(match);
    const parentRoots = this.#matchedParentContextualRoots(match);
    const parts = [
      ...(receiverPart ? [receiverPart] : []),
      ...argumentParts,
      ...(parentRoots.length ? [parentRoots] : []),
    ];
    return parts.length ? parts.flat() : null;
  }

  #receiverUpstream(match: UpstreamMatch): readonly Root[] | null {
    const { hostCall } = match;
    if (!ts.isPropertyAccessExpression(hostCall.expression)) {
      return null;
    }
    const receiverMatch = this.#types.receiverSharedParameters(
      match.declaration,
      match.declaredSignature,
      match.targetParameters
    );
    if (!receiverMatch.shared.size) {
      return null;
    }
    const receiverNode = hostCall.expression.expression;
    return this.unpackIfCollection(
      this.#context.trace(receiverNode),
      receiverNode,
      receiverMatch,
      match.targetContract
    );
  }

  #argumentUpstream(match: UpstreamMatch): (readonly Root[])[] {
    const { callback, declaredSignature } = match;
    const callArguments = match.hostCall.arguments ?? [];
    const callbackIndex = callArguments.findIndex(
      (argument) =>
        argument === callback || unwrapExpression(argument) === callback
    );
    const parts: (readonly Root[])[] = [];
    for (const [otherIndex, otherArgument] of callArguments.entries()) {
      const otherSymbol =
        otherIndex === callbackIndex
          ? undefined
          : declaredSignature.parameters[
              Math.min(otherIndex, declaredSignature.parameters.length - 1)
            ];
      const otherContract =
        otherSymbol && this.#checker.getTypeOfSymbol(otherSymbol);
      const part =
        otherContract &&
        this.#argumentPart({
          match,
          callbackIndex,
          otherIndex,
          otherArgument,
          otherContract,
        });
      if (part) {
        parts.push(part);
      }
    }
    return parts;
  }

  #argumentPart(upstream: UpstreamArgument): readonly Root[] | null {
    const { match, otherArgument, otherContract } = upstream;
    const otherCallables = otherContract
      .getNonNullableType()
      .getCallSignatures();
    if (!otherCallables.length) {
      const shared = this.#types.sharedTypeParameters(
        otherContract,
        match.targetParameters
      );
      if (!shared.size) {
        return null;
      }
      const traced = this.#context.trace(otherArgument);
      return this.unpackIfCollection(
        traced,
        otherArgument,
        {
          shared,
          sourceIsCollection: this.#types.isCollectionOver(
            otherContract,
            shared
          ),
        },
        match.targetContract
      );
    }
    const callbackMatch =
      upstream.callbackIndex < 0 || upstream.otherIndex < upstream.callbackIndex
        ? this.#types.sharedCallbackOutput(
            otherCallables,
            match.targetParameters
          )
        : NO_COLLECTION_MATCH;
    if (callbackMatch.shared.size === 0) {
      return null;
    }
    return this.callbackRoots(
      {
        argument: otherArgument,
        contract: otherContract,
        call: match.hostCall,
      },
      callbackMatch,
      match.targetContract
    );
  }

  #contextualSources(
    subject: ts.Symbol | undefined,
    callback: ts.Node,
    hostCall: HostCall | null,
    use: ts.Node
  ): readonly Root[] {
    if (!subject) {
      return [];
    }
    for (const declaration of subject.declarations ?? []) {
      const source = this.#context.declarations.platformSource(declaration);
      if (source) {
        const opaque = Boolean(
          source.opaque || broad(this.#checker.getTypeOfSymbol(subject))
        );
        return [{ kind: source.kind, root: use, declaration, opaque }];
      }
      const contract =
        ts.hasType(declaration) && declaration.type
          ? this.#checker.getTypeFromTypeNode(declaration.type)
          : undefined;
      const { typeParameters: targetParameters } =
        this.#types.returnedTypeParameters(contract);
      if (targetParameters.size && hostCall) {
        return (
          this.#matchedUpstreamRoots(
            callback,
            hostCall,
            targetParameters,
            contract
          ) ??
          callbackUpstreamCandidates(callback, hostCall).flatMap((candidate) =>
            this.#context.trace(candidate)
          )
        );
      }
    }
    return [];
  }

  #callbackBindings(callback: ts.SignatureDeclaration, site: CallbackSite) {
    const bound = new Map<ts.ParameterDeclaration, () => readonly Root[]>();
    const contextual = site.contract
      .getNonNullableType()
      .getCallSignatures()[0];
    for (const [index, parameter] of callback.parameters.entries()) {
      const subject = contextual?.parameters[index];
      bound.set(parameter, () =>
        subject
          ? this.#context.fixpoint({
              key: `contextual:${nodeKey(parameter)}@${nodeKey(site.argument)}`,
              subject: parameter,
              compute: () =>
                this.#contextualSources(
                  subject,
                  callback,
                  site.call,
                  parameter
                ),
            })
          : []
      );
    }
    return bound;
  }

  #callbackResultRoots(site: CallbackSite): readonly Root[] {
    const { argument, contract, call } = site;
    const literal = callbackNodes(argument);
    if (literal.length) {
      return literal.flatMap((callback) =>
        callbackReturns(callback).flatMap((expression) =>
          this.#context.trace(expression)
        )
      );
    }
    const declared = this.#callbacks.callbackDeclaration(argument);
    if (declared) {
      return this.#context.substituteAll(
        this.#context.summary(declared),
        this.#callbackBindings(declared, site)
      );
    }
    const roots: Root[] = ts.isCallExpression(argument)
      ? [...this.#context.trace(argument)]
      : [];
    const contextual = contract.getNonNullableType().getCallSignatures()[0];
    if (!contextual) {
      return roots;
    }
    for (const signature of this.#callbacks.pointFreeSignatures(
      argument,
      call
    )) {
      const { typeParameters: signatureOutput } =
        this.#types.returnedTypeParameters(
          this.#checker.getReturnTypeOfSignature(signature)
        );
      for (const [paramIndex, paramSymbol] of signature.parameters.entries()) {
        const shared = this.#types.sharedTypeParameters(
          this.#checker.getTypeOfSymbol(paramSymbol),
          signatureOutput
        );
        const subject = shared.size
          ? contextual.parameters[paramIndex]
          : undefined;
        if (subject) {
          roots.push(
            ...this.#contextualSources(subject, argument, call, argument)
          );
        }
      }
    }
    return roots;
  }
}
