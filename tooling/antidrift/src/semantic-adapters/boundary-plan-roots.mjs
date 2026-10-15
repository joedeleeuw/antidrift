import ts from "typescript";
import { broad, typed } from "./boundary-declarations.mjs";
import { boundaryObservations } from "./boundary-observations.mjs";
import { callbackReturns, unwrapExpression } from "./boundary-syntax.mjs";

const RETURNED_FUNCTION_DEPTH =
  boundaryObservations.bounds.returnedFunctionDepth.limit;

export function signatureForwarding({
  checker,
  observer,
  declarations,
  trace,
  summary,
  substituteAll,
  flagged,
}) {
  const { origin, platformSource } = declarations;

  function broadPayload(type, visited = new Set()) {
    if (!type || visited.has(type)) return false;
    visited.add(type);
    if (broad(type)) return true;
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

  function returnedTypeParameters(returned) {
    const typeParameters = new Set();
    const visited = new Set();
    let truncated = false;
    const pending = [[returned, 0]];
    while (pending.length) {
      const [current, depth] = pending.pop();
      if (!current || visited.has(current)) continue;
      if (depth > RETURNED_FUNCTION_DEPTH) {
        truncated = true;
        continue;
      }
      visited.add(current);
      if (current.flags & ts.TypeFlags.TypeParameter) {
        typeParameters.add(current);
      }
      const members = current.isUnionOrIntersection() ? current.types : [];
      for (const member of [...members, ...checker.getTypeArguments(current)]) {
        pending.push([member, depth]);
      }
      for (const signature of current.getCallSignatures()) {
        pending.push([checker.getReturnTypeOfSignature(signature), depth + 1]);
      }
    }
    return { typeParameters, truncated };
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
    return Boolean(
      sourceOpaque || broad(declaredOutput) || typeParameters.size || truncated
    );
  }

  function callbackNodes(argument) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      return [argument];
    }
    if (!ts.isObjectLiteralExpression(argument)) return [];
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
      if (contract?.flags & ts.TypeFlags.TypeParameter && hostCall) {
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
    if (!ts.isExpression(callback)) return [];
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
      if (roots.length) return roots;
    }
    return [];
  }

  function callbackBindings(callback, contract, call) {
    const bound = new Map();
    const contextual = contract.getNonNullableType().getCallSignatures()[0];
    for (const [index, parameter] of callback.parameters.entries()) {
      const subject = contextual?.parameters[index];
      bound.set(parameter, () =>
        subject ? contextualSources(subject, callback, call, parameter) : []
      );
    }
    return bound;
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
        callbackBindings(declared, contract, call)
      );
    }
    return ts.isCallExpression(argument) ? trace(argument) : [];
  }

  function receiverRoots(call, signature, output) {
    const { declaration } = signature;
    if (!declaration || !ts.isCallExpression(call)) return [];
    const receiverParameters =
      declaration?.parent?.typeParameters?.map((parameter) =>
        checker.getTypeAtLocation(parameter)
      ) ?? [];
    const methodLike =
      ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration);
    const receiverTyped =
      receiverParameters.some((parameter) => output.has(parameter)) ||
      (!output.size && methodLike);
    if (!receiverTyped || !ts.isPropertyAccessExpression(call.expression)) {
      return [];
    }
    const returned = checker.getReturnTypeOfSignature(signature);
    const projection =
      !output.size &&
      origin(declaration, call) === "platform" &&
      typed(returned) &&
      !broadPayload(returned);
    const inherited = trace(call.expression.expression);
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
      if (!unsettled) return [];
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
    const { typeParameters: output, truncated } = returnedTypeParameters(
      checker.getReturnTypeOfSignature(signature)
    );
    const roots = [];
    const callArguments = call.arguments ?? [];
    for (const [index, parameter] of signature.parameters.entries()) {
      const argument = callArguments[index];
      if (!argument) continue;
      const contract = checker.getTypeOfSymbol(parameter);
      const mentionsOutput = [
        ...returnedTypeParameters(contract).typeParameters,
      ].some((candidate) => output.has(candidate));
      const callable = contract.getNonNullableType().getCallSignatures();
      const sharesOutput = callable.some((callback) =>
        [
          ...returnedTypeParameters(checker.getReturnTypeOfSignature(callback))
            .typeParameters,
        ].some((candidate) => output.has(candidate))
      );
      if (mentionsOutput && !callable.length) {
        roots.push(...trace(argument));
      }
      if (
        sharesOutput ||
        (ts.isObjectLiteralExpression(argument) &&
          callbackNodes(argument).length)
      ) {
        roots.push(...callbackResultRoots(argument, contract, call));
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
