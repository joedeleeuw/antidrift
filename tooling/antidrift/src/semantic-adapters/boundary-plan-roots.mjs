import ts from "typescript";
import {
  collectionCases,
  nonForwardingOutputCases,
} from "./boundary/decision-cases.ts";
import { ELEMENT } from "./boundary/boundary-contracts.ts";
import { broad, typed } from "./boundary/boundary-types.ts";
import { boundaryObservations } from "./boundary/boundary-observations.ts";
import { nodeKey } from "./boundary/root-domain.ts";
import {
  callbackReturns,
  unwrapExpression,
} from "./boundary/boundary-syntax.ts";

const RETURNED_FUNCTION_DEPTH =
  boundaryObservations.bounds.returnedFunctionDepth.limit;

function isNonForwardingReturn(returned) {
  if (!returned) {
    return true;
  }
  return nonForwardingOutputCases.some((row) => {
    if (row.property) {
      return Boolean(returned[row.property]);
    }
    if (row.numeric) {
      return Boolean(
        returned.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)
      );
    }
    if (row.voidLike) {
      return Boolean(returned.flags & ts.TypeFlags.Void);
    }
    return false;
  });
}

export function signatureForwarding({
  checker,
  observer,
  declarations,
  trace,
  summary,
  fixpoint,
  substituteAll,
  flagged,
  prefixed,
  projected,
  elementStep,
}) {
  const { origin, platformSource } = declarations;

  function broadPayload(type, visited = new Set()) {
    if (!type || visited.has(type)) {
      return false;
    }
    visited.add(type);
    if (broad(type)) {
      return true;
    }
    if (type.isUnion()) {
      return type.types.some((member) => broadPayload(member, visited));
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      return checker
        .getTypeArguments(type)
        .some((argument) => broadPayload(argument, visited));
    }
    return false;
  }

  function enqueueCompositeChildren(current, depth, pending) {
    const members = current.isUnionOrIntersection() ? current.types : [];
    const aliasArguments = current.aliasTypeArguments ?? [];
    for (const member of [
      ...members,
      ...(current.objectFlags & ts.ObjectFlags.Reference
        ? checker.getTypeArguments(current)
        : []),
      ...aliasArguments,
    ]) {
      pending.push([member, depth]);
    }
    for (const indexSignature of checker.getIndexInfosOfType(current)) {
      pending.push([indexSignature.type, depth]);
    }
    const symbolDeclaration = current.symbol?.declarations?.[0];
    if (symbolDeclaration && ts.isTypeLiteralNode(symbolDeclaration)) {
      for (const property of checker.getPropertiesOfType(current)) {
        pending.push([checker.getTypeOfSymbol(property), depth]);
      }
    }
    for (const compositeChild of [
      current.templateType,
      current.objectType,
      current.indexType,
    ]) {
      if (compositeChild) {
        pending.push([compositeChild, depth]);
      }
    }
  }

  function returnedTypeParameters(returned) {
    const typeParameters = new Set();
    const visited = new Set();
    let truncated = false;
    const pending = [[returned, 0]];
    while (pending.length) {
      const [current, depth] = pending.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      if (depth > RETURNED_FUNCTION_DEPTH) {
        truncated = true;
        continue;
      }
      visited.add(current);
      if (current.flags & ts.TypeFlags.TypeParameter && !current.isThisType) {
        typeParameters.add(current);
        const constraintNode = current.symbol?.declarations?.[0]?.constraint;
        const constraint =
          constraintNode && checker.getTypeFromTypeNode(constraintNode);
        if (
          constraint &&
          constraint.flags & ts.TypeFlags.TypeParameter &&
          !constraint.isThisType
        ) {
          pending.push([constraint, depth]);
        }
      }
      enqueueCompositeChildren(current, depth, pending);
      for (const signature of current.getCallSignatures()) {
        pending.push([checker.getReturnTypeOfSignature(signature), depth + 1]);
      }
    }
    return { typeParameters, truncated };
  }

  function sharedTypeParameters(type, targetSet) {
    const shared = new Set();
    if (!type || !targetSet?.size) {
      return shared;
    }
    for (const candidate of returnedTypeParameters(type).typeParameters) {
      if (targetSet.has(candidate)) {
        shared.add(candidate);
      }
    }
    return shared;
  }

  function collectionElements(type) {
    const nonNull = type?.getNonNullableType();
    if (!nonNull) {
      return [];
    }
    const symbolName =
      nonNull.symbol?.name ?? nonNull.target?.symbol?.name ?? null;
    const collectionRow = collectionCases.find((row) =>
      row.symbols.includes(symbolName)
    );
    if (collectionRow) {
      const typeArguments = checker.getTypeArguments(nonNull);
      const element = typeArguments[collectionRow.elementIndex];
      return element ? [element] : typeArguments;
    }
    if (checker.isArrayLikeType(nonNull) && !checker.isTupleType(nonNull)) {
      const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number);
      return indexed ? [indexed] : checker.getTypeArguments(nonNull);
    }
    return [];
  }

  function isCollectionOver(type, targetSet) {
    if (!type || !targetSet?.size) {
      return false;
    }
    const nonNull = type.getNonNullableType();
    if (nonNull.isUnion()) {
      return nonNull.types.some((member) =>
        isCollectionOver(member, targetSet)
      );
    }
    const elements = collectionElements(nonNull);
    if (elements.length) {
      return elements.some(
        (element) => sharedTypeParameters(element, targetSet).size > 0
      );
    }
    if (nonNull.templateType && nonNull.constraintType) {
      return sharedTypeParameters(nonNull.templateType, targetSet).size > 0;
    }
    const promised = checker.getPromisedTypeOfPromise(nonNull);
    return Boolean(
      promised && promised !== nonNull && isCollectionOver(promised, targetSet)
    );
  }

  function unpackIfCollection(
    roots,
    sourceNode,
    sourceIsCollection,
    targetType,
    sharedSet
  ) {
    if (
      sourceIsCollection &&
      sharedSet.size > 0 &&
      !isCollectionOver(targetType, sharedSet)
    ) {
      return projected(roots, elementStep(sourceNode));
    }
    return roots;
  }

  function packIfCollection(
    roots,
    call,
    sourceIsCollection,
    targetType,
    sharedSet
  ) {
    if (
      !sourceIsCollection &&
      sharedSet.size > 0 &&
      isCollectionOver(targetType, sharedSet)
    ) {
      return roots.map((root) => prefixed(root, ELEMENT, call));
    }
    return roots;
  }

  function sharedCallbackOutput(callables, targetSet) {
    const shared = new Set();
    let sourceIsCollection = false;
    for (const signature of callables) {
      const callbackReturn = checker.getReturnTypeOfSignature(signature);
      const callbackShared = sharedTypeParameters(callbackReturn, targetSet);
      if (!callbackShared.size) {
        continue;
      }
      for (const parameterType of callbackShared) {
        shared.add(parameterType);
      }
      if (isCollectionOver(callbackReturn, callbackShared)) {
        sourceIsCollection = true;
      }
    }
    return { shared, sourceIsCollection };
  }

  function callOpaque(declaration, sourceOpaque, call) {
    const declaredSignature = checker.getSignatureFromDeclaration(declaration);
    const rawOutput =
      declaredSignature && checker.getReturnTypeOfSignature(declaredSignature);
    const declaredOutput =
      rawOutput && (checker.getPromisedTypeOfPromise(rawOutput) ?? rawOutput);
    const { typeParameters, truncated } = returnedTypeParameters(rawOutput);
    if (truncated && observer.enabled) {
      observer.boundFired(boundaryObservations.bounds.returnedFunctionDepth, {
        call,
        declaration,
      });
    }
    const parentParameters = new Set(
      declaration?.parent?.typeParameters?.map((parameter) =>
        checker.getTypeAtLocation(parameter)
      ) ?? []
    );
    const receiverType =
      call &&
      ts.isPropertyAccessExpression(call.expression) &&
      checker.getTypeAtLocation(call.expression.expression);
    const receiverArguments =
      receiverType &&
      checker.getTypeArguments(receiverType.getNonNullableType());
    const narrowedReceiver =
      !sourceOpaque &&
      typeParameters.size > 0 &&
      [...typeParameters].every((parameter) =>
        parentParameters.has(parameter)
      ) &&
      Boolean(receiverArguments?.length) &&
      !receiverArguments.some(broad);
    return Boolean(
      sourceOpaque ||
      broad(declaredOutput) ||
      (typeParameters.size && !narrowedReceiver) ||
      truncated
    );
  }

  function callbackNodes(argument) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      return [argument];
    }
    if (!ts.isObjectLiteralExpression(argument)) {
      return [];
    }
    return argument.properties.flatMap((property) => {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isArrowFunction(property.initializer) ||
          ts.isFunctionExpression(property.initializer))
      ) {
        return [property.initializer];
      }
      return ts.isMethodDeclaration(property) ? [property] : [];
    });
  }

  function callbackDeclaration(argument) {
    const unwrapped = unwrapExpression(argument);
    if (
      !unwrapped ||
      (!ts.isIdentifier(unwrapped) && !ts.isPropertyAccessExpression(unwrapped))
    ) {
      return null;
    }
    const symbol = checker.getSymbolAtLocation(unwrapped);
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    for (const declaration of target?.declarations ?? []) {
      const candidate = ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : declaration;
      if (
        candidate &&
        ts.isFunctionLike(candidate) &&
        candidate.body &&
        origin(candidate, argument) === null
      ) {
        return candidate;
      }
    }
    return null;
  }

  function callbackUpstreamCandidates(callback, call) {
    const candidates = [...(call.arguments ?? [])].filter(
      (argument) => unwrapExpression(argument) !== callback
    );
    if (ts.isPropertyAccessExpression(call.expression)) {
      candidates.push(call.expression.expression);
    }
    if (ts.isCallExpression(call.parent)) {
      if (ts.isPropertyAccessExpression(call.parent.expression)) {
        candidates.push(call.parent.expression.expression);
      }
      const position = call.parent.arguments.indexOf(call);
      candidates.push(...call.parent.arguments.slice(0, position));
    }
    return candidates;
  }

  function receiverSharedParameters(declaration, declaredSignature, targetSet) {
    const parentDeclaration = declaration?.parent;
    const parentParameters =
      parentDeclaration?.typeParameters?.map((parameter) =>
        checker.getTypeAtLocation(parameter)
      ) ?? [];
    const sharedParent = new Set(
      parentParameters.filter((parameter) => targetSet.has(parameter))
    );
    if (sharedParent.size) {
      const parentName =
        parentDeclaration?.name?.getText(declaration.getSourceFile()) ?? null;
      const collectionRow = collectionCases.find((row) =>
        row.symbols.includes(parentName)
      );
      const elementParameter = collectionRow
        ? (parentParameters[collectionRow.elementIndex] ?? parentParameters[0])
        : null;
      return {
        shared: sharedParent,
        sourceIsCollection: Boolean(
          elementParameter && sharedParent.has(elementParameter)
        ),
      };
    }
    const thisContract =
      declaredSignature.thisParameter &&
      checker.getTypeOfSymbol(declaredSignature.thisParameter);
    const sharedThis = sharedTypeParameters(thisContract, targetSet);
    return {
      shared: sharedThis,
      sourceIsCollection: isCollectionOver(thisContract, sharedThis),
    };
  }

  function matchedParentContextualRoots(
    hostCall,
    declaredSignature,
    targetParameters
  ) {
    if (!ts.isCallExpression(hostCall.parent)) {
      return [];
    }
    const hostReturned = checker.getReturnTypeOfSignature(declaredSignature);
    const parentContextual = checker
      .getContextualType(hostCall)
      ?.getNonNullableType()
      .getCallSignatures()[0];
    if (!parentContextual) {
      return [];
    }
    const roots = [];
    for (const returnedSig of hostReturned
      ?.getNonNullableType()
      .getCallSignatures() ?? []) {
      for (const [
        paramIndex,
        paramSymbol,
      ] of returnedSig.parameters.entries()) {
        const parentSubject = parentContextual.parameters[paramIndex];
        if (
          parentSubject &&
          sharedTypeParameters(
            checker.getTypeOfSymbol(paramSymbol),
            targetParameters
          ).size > 0
        ) {
          roots.push(
            ...contextualSources(
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

  function matchedUpstreamRoots(
    callback,
    hostCall,
    targetParameters,
    targetContract
  ) {
    const declaration = checker.getResolvedSignature(hostCall)?.declaration;
    const declaredSignature =
      declaration && checker.getSignatureFromDeclaration(declaration);
    if (!declaration || !declaredSignature) {
      return null;
    }
    const roots = [];
    let matched = false;
    if (ts.isPropertyAccessExpression(hostCall.expression)) {
      const receiverMatch = receiverSharedParameters(
        declaration,
        declaredSignature,
        targetParameters
      );
      if (receiverMatch.shared.size) {
        matched = true;
        const receiverNode = hostCall.expression.expression;
        roots.push(
          ...unpackIfCollection(
            trace(receiverNode),
            receiverNode,
            receiverMatch.sourceIsCollection,
            targetContract,
            receiverMatch.shared
          )
        );
      }
    }
    const callArguments = hostCall.arguments ?? [];
    const callbackIndex = callArguments.findIndex(
      (argument) =>
        argument === callback || unwrapExpression(argument) === callback
    );
    for (const [otherIndex, otherArgument] of callArguments.entries()) {
      if (!otherArgument || otherIndex === callbackIndex) {
        continue;
      }
      const otherSymbol =
        declaredSignature.parameters[
          Math.min(otherIndex, declaredSignature.parameters.length - 1)
        ];
      const otherContract = otherSymbol && checker.getTypeOfSymbol(otherSymbol);
      if (!otherContract) {
        continue;
      }
      const otherCallables = otherContract
        .getNonNullableType()
        .getCallSignatures();
      if (!otherCallables.length) {
        const shared = sharedTypeParameters(otherContract, targetParameters);
        if (shared.size) {
          matched = true;
          roots.push(
            ...unpackIfCollection(
              trace(otherArgument),
              otherArgument,
              isCollectionOver(otherContract, shared),
              targetContract,
              shared
            )
          );
        }
        continue;
      }
      const callbackMatch =
        callbackIndex < 0 || otherIndex < callbackIndex
          ? sharedCallbackOutput(otherCallables, targetParameters)
          : { shared: new Set(), sourceIsCollection: false };
      if (callbackMatch.shared.size > 0) {
        matched = true;
        const callbackRoots = packIfCollection(
          callbackResultRoots(otherArgument, otherContract, hostCall),
          hostCall,
          callbackMatch.sourceIsCollection,
          targetContract,
          callbackMatch.shared
        );
        roots.push(
          ...unpackIfCollection(
            callbackRoots,
            otherArgument,
            callbackMatch.sourceIsCollection,
            targetContract,
            callbackMatch.shared
          )
        );
      }
    }
    const parentRoots = matchedParentContextualRoots(
      hostCall,
      declaredSignature,
      targetParameters
    );
    if (parentRoots.length) {
      matched = true;
      roots.push(...parentRoots);
    }
    return matched ? roots : null;
  }

  function contextualSources(subject, callback, hostCall, use) {
    for (const declaration of subject?.declarations ?? []) {
      const source = platformSource(declaration);
      if (source) {
        const opaque = Boolean(
          source.opaque || broad(checker.getTypeOfSymbol(subject))
        );
        return [{ kind: source.kind, root: use, declaration, opaque }];
      }
      const contract =
        declaration.type && checker.getTypeFromTypeNode(declaration.type);
      const { typeParameters: targetParameters } =
        returnedTypeParameters(contract);
      if (targetParameters.size && hostCall) {
        const matched = matchedUpstreamRoots(
          callback,
          hostCall,
          targetParameters,
          contract
        );
        if (matched !== null) {
          return matched;
        }
        return callbackUpstreamCandidates(callback, hostCall).flatMap(
          (candidate) => trace(candidate)
        );
      }
    }
    return [];
  }

  function hostCallOf(callback) {
    let current = callback;
    while (current.parent) {
      const { parent } = current;
      if (
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.arguments?.includes(current)
      ) {
        return parent;
      }
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) {
        current = parent;
        continue;
      }
      return null;
    }
    return null;
  }

  function contextualParameterRoots(parameter) {
    const callback = parameter.parent;
    if (!ts.isExpression(callback)) {
      return [];
    }
    const index = callback.parameters.indexOf(parameter);
    const contextual = checker.getContextualType(callback);
    const hostCall = hostCallOf(callback);
    for (const signature of contextual
      ?.getNonNullableType()
      .getCallSignatures() ?? []) {
      const roots = contextualSources(
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

  // A callback parameter bound from its host call can lead back to the same
  // binding: a reducer's state is fed by the reducer's own result through the
  // shared type parameter. The binding is one fixpoint per (parameter, host
  // call argument), so one callback passed in two positions binds each apart.
  function callbackBindings(callback, contract, argument) {
    const bound = new Map();
    const contextual = contract.getNonNullableType().getCallSignatures()[0];
    for (const [index, parameter] of callback.parameters.entries()) {
      const subject = contextual?.parameters[index];
      bound.set(parameter, () =>
        subject
          ? fixpoint({
              key: `contextual:${nodeKey(parameter)}@${nodeKey(argument)}`,
              subject: parameter,
              compute: () =>
                contextualSources(
                  subject,
                  callback,
                  argument.parent,
                  parameter
                ),
            })
          : []
      );
    }
    return bound;
  }

  function pointFreeSignatures(argument, hostCall) {
    const unwrapped = unwrapExpression(argument);
    if (!unwrapped || ts.isFunctionLike(unwrapped)) {
      return [];
    }
    if (ts.isCallExpression(unwrapped)) {
      const declaration = checker.getResolvedSignature(unwrapped)?.declaration;
      if (
        !declaration ||
        (origin(declaration, hostCall) === null && declaration.body)
      ) {
        return [];
      }
      const declared = checker.getSignatureFromDeclaration(declaration);
      const returned = declared && checker.getReturnTypeOfSignature(declared);
      return returned?.getNonNullableType().getCallSignatures() ?? [];
    }
    if (
      ts.isIdentifier(unwrapped) ||
      ts.isPropertyAccessExpression(unwrapped)
    ) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const declaration = target?.declarations?.[0];
      if (
        !declaration ||
        (origin(declaration, hostCall) === null && declaration.body)
      ) {
        return [];
      }
      const declaredType =
        (declaration.type && checker.getTypeFromTypeNode(declaration.type)) ??
        checker.getTypeOfSymbol(target);
      return declaredType?.getNonNullableType().getCallSignatures() ?? [];
    }
    return [];
  }

  function callbackResultRoots(argument, contract, call) {
    const literal = callbackNodes(argument);
    if (literal.length) {
      return literal.flatMap((callback) =>
        callbackReturns(callback).flatMap((expression) => trace(expression))
      );
    }
    const declared = callbackDeclaration(argument);
    if (declared) {
      return substituteAll(
        summary(declared),
        callbackBindings(declared, contract, argument)
      );
    }
    const roots = ts.isCallExpression(argument) ? [...trace(argument)] : [];
    const contextual = contract.getNonNullableType().getCallSignatures()[0];
    if (!contextual) {
      return roots;
    }
    for (const signature of pointFreeSignatures(argument, call)) {
      const { typeParameters: signatureOutput } = returnedTypeParameters(
        checker.getReturnTypeOfSignature(signature)
      );
      for (const [paramIndex, paramSymbol] of signature.parameters.entries()) {
        const shared = sharedTypeParameters(
          checker.getTypeOfSymbol(paramSymbol),
          signatureOutput
        );
        const subject = shared.size
          ? contextual.parameters[paramIndex]
          : undefined;
        if (subject) {
          roots.push(...contextualSources(subject, argument, call, argument));
        }
      }
    }
    return roots;
  }

  function receiverRoots(call, signature, output) {
    const { declaration } = signature;
    if (!declaration || !ts.isCallExpression(call)) {
      return [];
    }
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return [];
    }
    const returned = checker.getReturnTypeOfSignature(signature);
    const receiverMatch = receiverSharedParameters(
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
      origin(declaration, call) === "platform" &&
      typed(returned) &&
      !broadPayload(returned);
    const receiverNode = call.expression.expression;
    const inherited = unpackIfCollection(
      trace(receiverNode),
      receiverNode,
      receiverMatch.sourceIsCollection,
      returned,
      receiverMatch.shared
    );
    return projection
      ? inherited.map((root) =>
          root.incomplete ? root : flagged(root, { opaque: false })
        )
      : inherited;
  }

  function truncatedRoots(call, signature, output) {
    return signature.parameters.flatMap((parameter, index) => {
      const unsettled =
        call.arguments?.[index] &&
        [
          ...returnedTypeParameters(checker.getTypeOfSymbol(parameter))
            .typeParameters,
        ].some((candidate) => !output.has(candidate));
      if (!unsettled) {
        return [];
      }
      return [
        {
          kind: "unresolved-declaration",
          root: call.arguments[index],
          declaration: signature.declaration,
          opaque: true,
          incomplete: `generic return deeper than ${RETURNED_FUNCTION_DEPTH} returned functions`,
        },
      ];
    });
  }

  function forwardedRoots(call, signature) {
    const returned = checker.getReturnTypeOfSignature(signature);
    if (
      isNonForwardingReturn(returned) &&
      isNonForwardingReturn(checker.getAwaitedType(returned))
    ) {
      return [];
    }
    const { typeParameters: output, truncated } =
      returnedTypeParameters(returned);
    const roots = [];
    const callArguments = call.arguments ?? [];
    for (const [index, parameter] of signature.parameters.entries()) {
      const argument = callArguments[index];
      if (!argument) {
        continue;
      }
      const contract = checker.getTypeOfSymbol(parameter);
      const shared = sharedTypeParameters(contract, output);
      const callable = contract.getNonNullableType().getCallSignatures();
      const callbackMatch = sharedCallbackOutput(callable, output);
      if (shared.size > 0 && !callable.length) {
        roots.push(
          ...unpackIfCollection(
            trace(argument),
            argument,
            isCollectionOver(contract, shared),
            returned,
            shared
          )
        );
      }
      if (
        callbackMatch.shared.size > 0 ||
        (ts.isObjectLiteralExpression(argument) &&
          callbackNodes(argument).length)
      ) {
        const callbackRoots = packIfCollection(
          callbackResultRoots(argument, contract, call),
          call,
          callbackMatch.sourceIsCollection,
          returned,
          callbackMatch.shared
        );
        roots.push(
          ...unpackIfCollection(
            callbackRoots,
            argument,
            callbackMatch.sourceIsCollection,
            returned,
            callbackMatch.shared
          )
        );
      }
    }
    roots.push(...receiverRoots(call, signature, output));
    if (truncated) {
      const unsettled = truncatedRoots(call, signature, output);
      if (observer.enabled) {
        observer.boundFired(boundaryObservations.bounds.returnedFunctionDepth, {
          call,
          declaration: signature.declaration,
          unsettledParameters: unsettled.length,
        });
      }
      roots.push(...unsettled);
    }
    return roots;
  }

  return {
    callOpaque,
    contextualParameterRoots,
    forwardedRoots,
  };
}
