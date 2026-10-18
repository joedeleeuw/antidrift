import ts from "typescript";

import type { BoundaryDeclarations } from "./boundary-declarations.ts";
import type { BoundaryObserver } from "./boundary-observations.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import { broad, typed } from "./boundary-types.ts";
import type { HostCall } from "./callback-sites.ts";
import { callbackNodes } from "./callback-sites.ts";
import type { CallbackSite, ContextualSources } from "./contextual-sources.ts";
import type { RootOperations } from "./root-algebra.ts";
import type { ConcreteRoot, Root } from "./root-domain.ts";
import type { TypeParameterSet } from "./type-parameter-flow.ts";
import {
  RETURNED_FUNCTION_DEPTH,
  TypeParameterFlow,
  enclosingTypeParameters,
  isNonForwardingReturn,
} from "./type-parameter-flow.ts";

type ForwardingContext = {
  readonly checker: ts.TypeChecker;
  readonly observer: BoundaryObserver;
  readonly declarations: BoundaryDeclarations;
  readonly trace: (expression: ts.Node | undefined) => readonly Root[];
  readonly flagged: RootOperations["flagged"];
  readonly contextual: ContextualSources;
};

type ForwardedArgument = CallbackSite & {
  readonly returned: ts.Type;
  readonly output: TypeParameterSet;
};

export class SignatureForwarding {
  readonly #context: ForwardingContext;
  readonly #checker: ts.TypeChecker;
  readonly #types: TypeParameterFlow;
  readonly #contextual: ContextualSources;

  constructor(context: ForwardingContext) {
    this.#context = context;
    this.#checker = context.checker;
    this.#types = new TypeParameterFlow(context.checker);
    this.#contextual = context.contextual;
  }

  callOpaque(
    declaration: NonNullable<ts.Signature["declaration"]>,
    sourceOpaque: boolean | undefined,
    call: HostCall | undefined
  ): boolean {
    const checker = this.#checker;
    const declaredSignature = checker.getSignatureFromDeclaration(declaration);
    const rawOutput =
      declaredSignature && checker.getReturnTypeOfSignature(declaredSignature);
    const declaredOutput =
      rawOutput && (checker.getPromisedTypeOfPromise(rawOutput) ?? rawOutput);
    const { typeParameters, truncated } =
      this.#types.returnedTypeParameters(rawOutput);
    if (truncated && this.#context.observer.enabled) {
      this.#context.observer.boundFired(
        boundaryObservations.bounds.returnedFunctionDepth,
        { call, declaration }
      );
    }
    const parentParameters = new Set(
      enclosingTypeParameters(declaration)?.map((parameter) =>
        checker.getTypeAtLocation(parameter)
      ) ?? []
    );
    const receiverArguments =
      call && ts.isPropertyAccessExpression(call.expression)
        ? checker.getTypeArguments(
            checker
              .getTypeAtLocation(call.expression.expression)
              .getNonNullableType()
          )
        : undefined;
    const narrowedReceiver =
      !sourceOpaque &&
      typeParameters.size > 0 &&
      [...typeParameters].every((parameter) =>
        parentParameters.has(parameter)
      ) &&
      receiverArguments !== undefined &&
      receiverArguments.length > 0 &&
      !receiverArguments.some(broad);
    return Boolean(
      sourceOpaque ||
      broad(declaredOutput) ||
      (typeParameters.size > 0 && !narrowedReceiver) ||
      truncated
    );
  }

  forwardedRoots(call: HostCall, signature: ts.Signature): Root[] {
    const returned = this.#checker.getReturnTypeOfSignature(signature);
    if (
      isNonForwardingReturn(returned) &&
      isNonForwardingReturn(this.#checker.getAwaitedType(returned))
    ) {
      return [];
    }
    const { typeParameters: output, truncated } =
      this.#types.returnedTypeParameters(returned);
    const roots: Root[] = [];
    const callArguments = call.arguments ?? [];
    for (const [index, parameter] of signature.parameters.entries()) {
      const argument = callArguments[index];
      if (argument) {
        roots.push(
          ...this.#forwardedArgumentRoots({
            call,
            argument,
            contract: this.#checker.getTypeOfSymbol(parameter),
            returned,
            output,
          })
        );
      }
    }
    roots.push(...this.#receiverRoots(call, signature, output));
    if (truncated) {
      const unsettled = this.#truncatedRoots(call, signature, output);
      if (this.#context.observer.enabled) {
        this.#context.observer.boundFired(
          boundaryObservations.bounds.returnedFunctionDepth,
          {
            call,
            declaration: signature.declaration,
            unsettledParameters: unsettled.length,
          }
        );
      }
      roots.push(...unsettled);
    }
    return roots;
  }

  #forwardedArgumentRoots(forwarded: ForwardedArgument): Root[] {
    const { call, argument, contract, returned, output } = forwarded;
    const roots: Root[] = [];
    const shared = this.#types.sharedTypeParameters(contract, output);
    const callable = contract.getNonNullableType().getCallSignatures();
    const callbackMatch = this.#types.sharedCallbackOutput(callable, output);
    if (shared.size > 0 && !callable.length) {
      const traced = this.#context.trace(argument);
      roots.push(
        ...this.#contextual.unpackIfCollection(
          traced,
          argument,
          {
            shared,
            sourceIsCollection: this.#types.isCollectionOver(contract, shared),
          },
          returned
        )
      );
    }
    if (
      callbackMatch.shared.size > 0 ||
      (ts.isObjectLiteralExpression(argument) && callbackNodes(argument).length)
    ) {
      roots.push(
        ...this.#contextual.callbackRoots(
          { argument, contract, call },
          callbackMatch,
          returned
        )
      );
    }
    return roots;
  }

  #receiverRoots(
    call: HostCall,
    signature: ts.Signature,
    output: TypeParameterSet
  ): readonly Root[] {
    const { declaration } = signature;
    if (
      !declaration ||
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression)
    ) {
      return [];
    }
    const returned = this.#checker.getReturnTypeOfSignature(signature);
    const receiverMatch = this.#types.receiverSharedParameters(
      declaration,
      signature,
      output
    );
    const methodLike =
      ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration);
    const receiverTyped =
      receiverMatch.shared.size > 0 || (!output.size && methodLike);
    if (!receiverTyped) {
      return [];
    }
    const projection =
      !output.size &&
      this.#context.declarations.origin(declaration, call) === "platform" &&
      typed(returned) &&
      !this.#types.broadPayload(returned);
    const receiverNode = call.expression.expression;
    const inherited = this.#contextual.unpackIfCollection(
      this.#context.trace(receiverNode),
      receiverNode,
      receiverMatch,
      returned
    );
    return projection
      ? inherited.map((root) =>
          !root.parameter && root.incomplete
            ? root
            : this.#context.flagged(root, { opaque: false })
        )
      : inherited;
  }

  #truncatedRoots(
    call: HostCall,
    signature: ts.Signature,
    output: TypeParameterSet
  ): ConcreteRoot[] {
    return signature.parameters.flatMap((parameter, index) => {
      const argument = call.arguments?.[index];
      if (!argument) {
        return [];
      }
      const unsettled = [
        ...this.#types.returnedTypeParameters(
          this.#checker.getTypeOfSymbol(parameter)
        ).typeParameters,
      ].some((candidate) => !output.has(candidate));
      if (!unsettled) {
        return [];
      }
      return [
        {
          kind: "unresolved-declaration",
          root: argument,
          declaration: signature.declaration,
          opaque: true,
          incomplete: `generic return deeper than ${RETURNED_FUNCTION_DEPTH} returned functions`,
        },
      ];
    });
  }
}
