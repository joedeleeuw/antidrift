import ts from "typescript";
import {
  ELEMENT,
  assertionKinds,
  contractProjection,
  logicalOperators,
  unresolvedType,
} from "./boundary-contracts.mjs";
import { classReceivers } from "./boundary-classes.mjs";
import {
  boundaryObservations,
  boundaryObserver,
} from "./boundary-observations.mjs";
import {
  boundaryDeclarations,
  broad,
  excluded,
} from "./boundary-declarations.mjs";
import { signatureForwarding } from "./boundary-plan-roots.mjs";
import { boundarySinks } from "./boundary-sinks.mjs";
import { boundarySources } from "./boundary-sources.mjs";
import {
  aliasTarget,
  declarationSummaries,
  dedupe,
  nodeKey,
  placeholder,
  rootAlgebra,
  unknownProvenance,
} from "./boundary-summaries.mjs";
import {
  callbackReturns,
  enclosingFunction,
  isAssertionChain,
  safeExpressionKinds,
  unconditionalBefore,
  unwrapExpression,
  wrapperKinds,
} from "./boundary-syntax.mjs";

const models = new WeakMap();

const binaryDispositions = new Map([
  ...[...logicalOperators].map((kind) => [kind, "both"]),
  [ts.SyntaxKind.QuestionQuestionEqualsToken, "both"],
  [ts.SyntaxKind.BarBarEqualsToken, "both"],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, "both"],
  [ts.SyntaxKind.EqualsToken, "right"],
  [ts.SyntaxKind.CommaToken, "right"],
  [ts.SyntaxKind.PlusToken, "concatenation"],
  [ts.SyntaxKind.PlusEqualsToken, "concatenation"],
]);

function once(compute) {
  let computed;
  return () => {
    computed ??= compute();
    return computed;
  };
}

export function boundaryModel(program, options = {}) {
  const existing = models.get(program);
  if (existing) {
    if (options.observe === undefined) {
      return existing.model;
    }
    if (existing.hasProxy) {
      existing.observer.setSink(options.observe, options.rootDirectory);
      return existing.model;
    }
  }
  const observer = boundaryObserver(
    program,
    options.observe,
    options.rootDirectory
  );
  const { checker } = observer;
  const contracts = contractProjection(checker);
  const { accessKeys, claimContract, propertyKeys } = contracts;
  const declarations = boundaryDeclarations(program, observer);
  const {
    carrierPath,
    decode,
    exported,
    narrowedToSuccess,
    origin,
    passesAssertion,
    platformSource,
    signatureDecode,
    signatureForm,
    unprovedNarrowing,
  } = declarations;
  const {
    captured,
    claimed,
    filtered,
    flagged,
    overridden,
    prefixed,
    projectRoot,
    substitute,
    substituteAll,
  } = rootAlgebra({ contracts, narrowedToSuccess, observer });
  const sources = boundarySources({
    checker,
    declarations,
    hasRoots: (expression) => resolvedTrace(expression).length > 0,
  });
  const {
    bindingSourceRoots,
    callersOf,
    exportedParameterRoots,
    frameworkRoot,
    incompleteCause,
    localReceiver,
    localString,
    memberSourceRoots,
    writes,
  } = sources;

  const visiting = new Set();
  let currentUse = null;

  function withClaim(roots, contract, node, claimOptions) {
    const claimedContract = claimContract(contract, claimOptions);
    if (!claimedContract) return roots;
    return roots.map((root) => claimed(root, claimedContract, node));
  }

  function declaredClaim(parameter) {
    const declared =
      parameter.type && checker.getTypeFromTypeNode(parameter.type);
    const contract = claimContract(declared);
    return contract ? { contract, node: parameter } : undefined;
  }

  function accessStep(expression, keys, elementKey, sourcesOf) {
    let derived;
    return {
      keys,
      elementKey,
      receiverType: checker.getTypeAtLocation(expression),
      assertionDerived: () => {
        derived ??= derivedThroughAssertion(expression);
        return derived;
      },
      at: nodeKey(expression),
      sources: once(sourcesOf),
    };
  }

  function elementStep(expression) {
    return {
      keys: null,
      elementKey: true,
      receiverType: checker.getTypeAtLocation(expression),
      assertionDerived: () => false,
      at: nodeKey(expression),
      sources: () => [],
    };
  }

  function projected(roots, step) {
    if (!roots.length) return step.sources();
    return roots.flatMap((root) => projectRoot(root, step));
  }

  function parameterRoots(parameter) {
    const ownerFn = parameter.parent;
    if (!ts.isFunctionLike(ownerFn)) return [];
    const signature = checker.getSignatureFromDeclaration(ownerFn);
    const decoder = signatureDecode(signature, parameter);
    const index = ownerFn.parameters.indexOf(parameter);
    if (excluded({ decoderSubject: decoder?.parameter === index })) return [];
    if (ts.isExpression(ownerFn)) {
      const contextual = forwarding.contextualParameterRoots(parameter);
      if (contextual.length) return contextual;
    }
    return [placeholder(parameter, declaredClaim(parameter))];
  }

  function argumentRootsAt(call, parameter, index) {
    const callArguments = callArgumentsOf(call);
    if (parameter.dotDotDotToken) {
      return callArguments
        .slice(index)
        .flatMap((argument) =>
          argument
            ? trace(argument).map((root) => prefixed(root, ELEMENT, call))
            : []
        );
    }
    const argument = callArguments[index] ?? parameter.initializer;
    return argument ? trace(argument) : [];
  }

  function incomingRoots(parameter) {
    const ownerFn = parameter.parent;
    const declared =
      parameter.type && checker.getTypeFromTypeNode(parameter.type);
    const index = ownerFn.parameters.indexOf(parameter);
    if (declared && exported(ownerFn)) {
      const boundary = exportedParameterRoots(parameter, declared);
      if (boundary.length) return boundary;
    }
    const callers = callersOf(ownerFn).flatMap((call) =>
      argumentRootsAt(call, parameter, index)
    );
    if (callers.length) return resolveAll(callers);
    return resolveAll(forwarding.contextualParameterRoots(parameter));
  }

  function resolveAll(roots) {
    return roots.flatMap((root) =>
      root.parameter ? substitute(root, summary(root.parameter)) : [root]
    );
  }

  function assignmentRoots(assignment) {
    return assignment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      ? concatenationRoots(assignment, [assignment.right])
      : trace(assignment.right);
  }

  function variableRoots(declaration) {
    const use = currentUse;
    const source = platformSource(declaration);
    if (source && !source.requiresProvenance) {
      const declaredType = checker.getTypeAtLocation(declaration);
      if (!declaredType.getCallSignatures().length) {
        const awaitedOutput = checker.getAwaitedType(declaredType);
        const opaque = Boolean(source.opaque || broad(awaitedOutput));
        return [{ kind: source.kind, root: use, declaration, opaque }];
      }
    }
    const declarationList = declaration.parent;
    if (
      ts.isVariableDeclarationList(declarationList) &&
      ts.isForOfStatement(declarationList.parent)
    ) {
      const iterated = declarationList.parent.expression;
      return projected(trace(iterated), elementStep(iterated));
    }
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const declaringFunction = enclosingFunction(declaration);
    const nestedUse =
      declaringFunction !== enclosingFunction(use) ||
      declaration.getSourceFile() !== use.getSourceFile();
    const assignments = writes(declaration.getSourceFile()).get(symbol) ?? [];
    const direct = assignments.filter(
      (assignment) =>
        enclosingFunction(assignment) === declaringFunction &&
        (nestedUse || assignment.end < use.pos)
    );
    const closureWrites = assignments.filter(
      (assignment) => enclosingFunction(assignment) !== declaringFunction
    );
    const last = nestedUse
      ? undefined
      : direct.findLast(
          (assignment) =>
            assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            unconditionalBefore(assignment, use)
        );
    const collected = [];
    if (last) {
      collected.push(...assignmentRoots(last));
    } else if (declaration.initializer) {
      collected.push(...trace(declaration.initializer));
    }
    for (const assignment of direct) {
      if (!last || assignment.pos > last.pos) {
        collected.push(...assignmentRoots(assignment));
      }
    }
    for (const assignment of closureWrites) {
      collected.push(...assignmentRoots(assignment));
    }
    return withClaim(
      collected,
      declaration.type && checker.getTypeFromTypeNode(declaration.type),
      declaration
    );
  }

  function bindingKeys(element) {
    const name = element.propertyName ?? element.name;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return new Set([name.text]);
    }
    return propertyKeys({ name });
  }

  function bindingCarrier(element) {
    const owner = element.parent.parent;
    let carrier = null;
    if (ts.isBindingElement(owner)) carrier = bindingCarrier(owner);
    else if (ts.isParameter(owner)) carrier = { parameter: owner, path: [] };
    else if (ts.isVariableDeclaration(owner) && owner.initializer) {
      carrier = carrierPath(owner.initializer);
    }
    const keys = ts.isObjectBindingPattern(element.parent)
      ? bindingKeys(element)
      : null;
    if (!carrier || carrier.deserialized || keys?.size !== 1) return null;
    return { ...carrier, path: [...carrier.path, [...keys][0]] };
  }

  function bindingElementRoots(element) {
    const pattern = element.parent;
    const owner = pattern.parent;
    const inherited = ts.isBindingElement(owner)
      ? bindingElementRoots(owner)
      : bindingRoots(owner, element);
    const defaults = element.initializer ? trace(element.initializer) : [];
    if (element.dotDotDotToken) {
      if (!ts.isObjectBindingPattern(pattern)) {
        return [...defaults, ...inherited];
      }
      const siblingKeys = new Set(
        pattern.elements
          .filter((sibling) => sibling !== element)
          .flatMap((sibling) => [...(bindingKeys(sibling) ?? [])])
      );
      return [...defaults, ...overridden(inherited, siblingKeys)];
    }
    const keys = ts.isObjectBindingPattern(pattern)
      ? bindingKeys(element)
      : null;
    const receiverType = checker.getTypeAtLocation(pattern);
    const step = {
      keys,
      elementKey: keys === null,
      receiverType,
      assertionDerived: () => false,
      at: nodeKey(pattern),
      sources: once(() =>
        bindingSourceRoots(element, receiverType, keys, bindingCarrier(element))
      ),
    };
    return [...defaults, ...projected(inherited, step)];
  }

  function bindingRoots(declaration, use) {
    if (ts.isParameter(declaration)) return parameterRoots(declaration);
    const previous = currentUse;
    currentUse = use;
    try {
      if (ts.isBindingElement(declaration)) {
        return bindingElementRoots(declaration);
      }
      if (ts.isVariableDeclaration(declaration)) {
        return variableRoots(declaration);
      }
      return [];
    } finally {
      currentUse = previous;
    }
  }

  function callResultContract(contract) {
    if (!contract || unresolvedType(contract)) return contract;
    const signature = contract.getNonNullableType().getCallSignatures()[0];
    return signature
      ? checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))
      : null;
  }

  function untypedCalleeRoots(call, callee) {
    return filtered(trace(callee), "opaqueOrIncomplete").map((root) => {
      const resultRoot = flagged(root, {
        root: call,
        path: undefined,
        overrides: undefined,
      });
      return resultRoot.claim
        ? {
            ...resultRoot,
            claim: {
              ...resultRoot.claim,
              contract: callResultContract(resultRoot.claim.contract),
            },
          }
        : resultRoot;
    });
  }

  function decoderSubject(argument) {
    const unwrapped = unwrapExpression(argument);
    if (!unwrapped || !ts.isIdentifier(unwrapped)) return false;
    return (checker.getSymbolAtLocation(unwrapped)?.declarations ?? []).some(
      (declaration) => {
        if (!ts.isParameter(declaration)) return false;
        const owner = declaration.parent;
        const evidence = signatureDecode(
          checker.getSignatureFromDeclaration(owner),
          declaration
        );
        return evidence?.parameter === owner.parameters.indexOf(declaration);
      }
    );
  }

  function deserializerRoots(call, argument, source, declaration) {
    if (!argument) return [];
    const { kind } = source;
    return captured(trace(argument), {
      kind,
      call,
      declaration,
      opaque: true,
      whenEmpty: () => {
        if (
          excluded({ local: localString(argument) }) ||
          decoderSubject(argument)
        ) {
          return [];
        }
        return [
          {
            kind,
            root: call,
            declaration,
            opaque: true,
            incomplete: incompleteCause(argument),
          },
        ];
      },
    });
  }

  function platformCallRoots(call, callee, source, declaration) {
    const construction =
      ts.isPropertyAccessExpression(callee) && localReceiver(callee.expression);
    const opaque = forwarding.callOpaque(declaration, source.opaque, call);
    if (excluded({ local: Boolean(construction) })) {
      return (construction.arguments ?? []).flatMap((argument) =>
        captured(trace(argument), {
          kind: source.kind,
          call,
          declaration,
          opaque,
          whenEmpty: () => [],
        })
      );
    }
    return typeArgumentClaim(call, [
      { kind: source.kind, root: call, declaration, opaque },
    ]);
  }

  function typeArgumentClaim(call, roots) {
    const typeArgument = call.typeArguments?.[0];
    return typeArgument
      ? withClaim(roots, checker.getTypeFromTypeNode(typeArgument), call, {
          allowTypeParameter: true,
        })
      : roots;
  }

  function argumentBindings(declaredParameters, callArguments) {
    const bound = new Map();
    for (const [index, parameter] of declaredParameters.entries()) {
      if (parameter.dotDotDotToken) {
        bound.set(
          parameter,
          once(() =>
            callArguments
              .slice(index)
              .flatMap((argument) =>
                argument
                  ? trace(argument).map((root) =>
                      prefixed(root, ELEMENT, argument)
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
        once(() => (argument ? trace(argument) : []))
      );
    }
    return bound;
  }

  function returnRoots(declaration) {
    return withClaim(
      callbackReturns(declaration).flatMap((expression) => trace(expression)),
      declaration.type &&
        checker.getAwaitedType(checker.getTypeFromTypeNode(declaration.type)),
      declaration
    );
  }

  function declarationRoots(declaration) {
    if (ts.isParameter(declaration)) return incomingRoots(declaration);
    if (ts.isClassLike(declaration)) return classFieldRoots(declaration);
    return returnRoots(declaration);
  }

  const { summary, fixpoint, recordCut, memoize } = declarationSummaries({
    bodyRoots: declarationRoots,
    observer,
    isActive: (node) => visiting.has(node),
  });

  const forwarding = signatureForwarding({
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
  });

  const { classFieldRoots, superRoots, thisRoots } = classReceivers({
    checker,
    origin,
    propertyKeys,
    trace,
    summary,
    parameterRoots,
    prefixed,
  });

  function calleeImplementation(callee, declaration) {
    if (declaration.body) return declaration;
    const target = aliasTarget(checker, checker.getSymbolAtLocation(callee));
    for (const node of [declaration.parent, ...(target?.declarations ?? [])]) {
      const candidate =
        node && ts.isVariableDeclaration(node) ? node.initializer : node;
      if (candidate && ts.isFunctionLike(candidate) && candidate.body) {
        return candidate;
      }
    }
    return null;
  }

  function callArgumentsOf(call) {
    if (ts.isTaggedTemplateExpression(call)) {
      const spans = ts.isTemplateExpression(call.template)
        ? call.template.templateSpans.map((span) => span.expression)
        : [];
      return [null, ...spans];
    }
    return [...(call.arguments ?? [])];
  }

  function decodedRoots(evidence) {
    const settled = evidence.kind === "result";
    return trace(evidence.input).map((root) =>
      flagged(root, {
        decoded: !settled,
        pending: settled ? evidence : undefined,
        claim: undefined,
        incomplete: undefined,
        ...(settled ? { opaque: false } : {}),
      })
    );
  }

  function stringified(roots) {
    return roots.map((root) =>
      root.incomplete
        ? root
        : flagged(root, { opaque: false, activation: "serialized-input" })
    );
  }

  function callRoots(call) {
    const callee = ts.isTaggedTemplateExpression(call)
      ? call.tag
      : call.expression;
    const callArguments = callArgumentsOf(call);
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!declaration) return untypedCalleeRoots(call, callee);
    const source = platformSource(declaration);
    if (source?.requiresProvenance) {
      return deserializerRoots(
        call,
        callArguments[source.argument],
        source,
        declaration
      );
    }
    if (source) return platformCallRoots(call, callee, source, declaration);
    const evidence = ts.isCallExpression(call) ? decode(call) : null;
    if (evidence) return decodedRoots(evidence);
    const request = frameworkRoot(callee);
    if (request) {
      return typeArgumentClaim(call, [
        {
          ...request,
          root: call,
          opaque: forwarding.callOpaque(declaration, false, call),
        },
      ]);
    }
    const implementation = calleeImplementation(callee, declaration);
    if (implementation && origin(implementation, call) === null) {
      return substituteAll(
        summary(implementation),
        argumentBindings(implementation.parameters, callArguments)
      );
    }
    const declared = checker.getSignatureFromDeclaration(declaration);
    if (!declared) return [];
    const candidate = signatureForm(declared);
    const forwarded = forwarding.forwardedRoots(call, declared);
    if (candidate && callArguments[candidate.parameter]) {
      const stringProjection =
        origin(declaration, call) === "platform" &&
        Boolean(candidate.output.flags & ts.TypeFlags.StringLike);
      const subject = trace(callArguments[candidate.parameter]);
      forwarded.push(
        ...(stringProjection
          ? stringified(subject)
          : subject.map((root) => flagged(root, { opaque: true })))
      );
    }
    const output = checker.getReturnTypeOfSignature(declared);
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

  function constructionRoots(expression) {
    const signature = checker.getResolvedSignature(expression);
    const declaration = signature?.declaration;
    const source = declaration && platformSource(declaration);
    if (source) {
      return typeArgumentClaim(expression, [
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
      origin(classDeclaration, expression) === null
    ) {
      const constructor = classDeclaration.members.find(
        ts.isConstructorDeclaration
      );
      return substituteAll(
        summary(classDeclaration),
        argumentBindings(constructor?.parameters ?? [], [
          ...(expression.arguments ?? []),
        ])
      );
    }
    if (!signature) {
      return unknownProvenance(expression, "construction without a signature");
    }
    return forwarding.forwardedRoots(expression, signature);
  }

  function derivedThroughAssertion(expression, visited = new Set()) {
    let unwrapped = expression;
    while (
      unwrapped &&
      wrapperKinds.has(unwrapped.kind) &&
      unwrapped.expression
    ) {
      unwrapped = unwrapped.expression;
    }
    if (!unwrapped || visited.has(unwrapped)) return false;
    visited.add(unwrapped);
    if (passesAssertion(expression)) return true;
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return derivedThroughAssertion(unwrapped.expression, visited);
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    return (checker.getSymbolAtLocation(unwrapped)?.declarations ?? []).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        derivedThroughAssertion(declaration.initializer, visited)
    );
  }

  function namespaceMemberRoots(expression) {
    if (!ts.isPropertyAccessExpression(expression)) return null;
    const receiver = aliasTarget(
      checker,
      checker.getSymbolAtLocation(expression.expression)
    );
    if (!receiver || !(receiver.flags & ts.SymbolFlags.Module)) return null;
    const member = aliasTarget(
      checker,
      checker.getSymbolAtLocation(expression.name)
    );
    return (member?.declarations ?? []).flatMap((declaration) =>
      bindingRoots(declaration, expression)
    );
  }

  function memberRoots(expression) {
    const namespaced = namespaceMemberRoots(expression);
    if (namespaced) return namespaced;
    const keys = accessKeys(expression);
    const receiver = expression.expression;
    const step = accessStep(
      receiver,
      keys,
      keys === null || [...keys].every((key) => /^\d+$/u.test(key)),
      () => memberSourceRoots(expression, checker.getTypeAtLocation(receiver))
    );
    return projected(trace(receiver), step);
  }

  function writtenKeys(property) {
    if (!ts.isSpreadAssignment(property)) {
      const keys = propertyKeys(property);
      return keys?.size === 1 ? [...keys] : [];
    }
    const spread = checker
      .getTypeAtLocation(property.expression)
      .getNonNullableType();
    return checker
      .getPropertiesOfType(spread)
      .filter((member) => !(member.flags & ts.SymbolFlags.Optional))
      .map((member) => member.name);
  }

  function propertyRoots(property) {
    if (ts.isSpreadAssignment(property)) {
      return trace(property.expression);
    }
    let inherited;
    if (ts.isPropertyAssignment(property)) {
      inherited = trace(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      const shorthandDeclarations =
        checker.getShorthandAssignmentValueSymbol(property)?.declarations ?? [];
      inherited = shorthandDeclarations.flatMap((declaration) =>
        bindingRoots(declaration, property)
      );
    } else {
      return [];
    }
    const keys = propertyKeys(property);
    if (!keys) return inherited;
    return [...keys].flatMap((key) =>
      inherited.map((root) => prefixed(root, key, property))
    );
  }

  function objectRoots(expression) {
    const written = expression.properties.map(writtenKeys);
    return expression.properties.flatMap((property, position) =>
      overridden(
        propertyRoots(property),
        new Set(written.slice(position + 1).flat())
      )
    );
  }

  function arrayRoots(expression) {
    return expression.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) return trace(element.expression);
      if (ts.isOmittedExpression(element)) return [];
      return trace(element).map((root) => prefixed(root, ELEMENT, element));
    });
  }

  function assertionRoots(expression) {
    const roots = trace(expression.expression);
    return isAssertionChain(expression)
      ? roots.map((root) => flagged(root, { castChain: true }))
      : withClaim(
          roots,
          checker.getTypeFromTypeNode(expression.type),
          expression,
          { allowTypeParameter: true }
        );
  }

  function identifierRoots(expression) {
    const target = aliasTarget(
      checker,
      checker.getSymbolAtLocation(expression)
    );
    return (target?.declarations ?? []).flatMap((declaration) =>
      bindingRoots(declaration, expression)
    );
  }

  function concatenationRoots(expression, operands) {
    const produced = checker.getTypeAtLocation(expression);
    if (!(produced.flags & ts.TypeFlags.StringLike)) return [];
    return operands.flatMap((operand) => stringified(trace(operand)));
  }

  function binaryRoots(expression) {
    const disposition =
      binaryDispositions.get(expression.operatorToken.kind) ?? "safe";
    if (disposition === "safe") return [];
    if (disposition === "right") return trace(expression.right);
    if (disposition === "concatenation") {
      return concatenationRoots(expression, [
        expression.left,
        expression.right,
      ]);
    }
    return [expression.left, expression.right].flatMap((branch) =>
      trace(branch)
    );
  }

  const expressionDispositions = new Map([
    ...[...safeExpressionKinds].map((kind) => [kind, () => []]),
    ...[...wrapperKinds]
      .filter((kind) => !assertionKinds.has(kind))
      .map((kind) => [
        kind,
        (expression) =>
          expression.expression ? trace(expression.expression) : [],
      ]),
    ...[...assertionKinds].map((kind) => [kind, assertionRoots]),
    [
      ts.SyntaxKind.YieldExpression,
      (expression) =>
        expression.asteriskToken && expression.expression
          ? trace(expression.expression)
          : unknownProvenance(expression, "yield receives the caller's input"),
    ],
    [
      ts.SyntaxKind.ExpressionWithTypeArguments,
      (expression) => trace(expression.expression),
    ],
    [
      ts.SyntaxKind.SpreadElement,
      (expression) =>
        projected(
          trace(expression.expression),
          elementStep(expression.expression)
        ),
    ],
    [ts.SyntaxKind.CallExpression, callRoots],
    [ts.SyntaxKind.TaggedTemplateExpression, callRoots],
    [ts.SyntaxKind.NewExpression, constructionRoots],
    [ts.SyntaxKind.PropertyAccessExpression, memberRoots],
    [ts.SyntaxKind.ElementAccessExpression, memberRoots],
    [ts.SyntaxKind.ObjectLiteralExpression, objectRoots],
    [ts.SyntaxKind.ArrayLiteralExpression, arrayRoots],
    [
      ts.SyntaxKind.ConditionalExpression,
      (expression) =>
        [expression.whenTrue, expression.whenFalse].flatMap((branch) =>
          trace(branch)
        ),
    ],
    [ts.SyntaxKind.BinaryExpression, binaryRoots],
    [
      ts.SyntaxKind.TemplateExpression,
      (expression) =>
        concatenationRoots(
          expression,
          expression.templateSpans.map((span) => span.expression)
        ),
    ],
    [ts.SyntaxKind.Identifier, identifierRoots],
    [ts.SyntaxKind.ThisKeyword, thisRoots],
    [ts.SyntaxKind.SuperKeyword, superRoots],
  ]);

  function traceExpression(expression) {
    const disposition = expressionDispositions.get(expression.kind);
    if (!disposition) {
      return unknownProvenance(
        expression,
        `unmodelled expression ${ts.SyntaxKind[expression.kind]}`
      );
    }
    return disposition(expression);
  }

  const traced = new Map();

  function observeMemo(reused) {
    if (!observer.enabled) return;
    observer.recordTraceCall();
    if (reused) {
      observer.recordMemoHit();
    } else {
      observer.recordMemoMiss();
    }
  }

  const TRACE_DEPTH = boundaryObservations.bounds.traceDepth.limit;

  function trace(expression) {
    if (!expression) return [];
    if (visiting.has(expression)) {
      recordCut(expression);
      return [];
    }
    if (visiting.size >= TRACE_DEPTH) {
      if (observer.enabled) {
        observer.boundFired(boundaryObservations.bounds.traceDepth, {
          depth: visiting.size,
          declaration: enclosingFunction(expression),
        });
      }
      return unknownProvenance(
        expression,
        `trace deeper than ${TRACE_DEPTH} expressions`
      );
    }
    visiting.add(expression);
    try {
      return memoize(
        traced,
        expression,
        () => dedupe(traceExpression(expression)),
        observeMemo
      );
    } finally {
      visiting.delete(expression);
    }
  }

  const resolvedTraces = new Map();

  function resolvedTrace(expression) {
    if (!expression) return [];
    return memoize(resolvedTraces, expression, () =>
      dedupe(resolveAll(trace(expression)))
    );
  }

  const { uncheckedAt, uncheckedArgument } = boundarySinks({
    program,
    checker,
    observer,
    trace: resolvedTrace,
    decode,
    unprovedNarrowing,
    contracts,
  });

  const model = {
    trace: resolvedTrace,
    decode,
    uncheckedAt,
    uncheckedArgument,
  };
  models.set(program, {
    model,
    observer,
    hasProxy: Boolean(options.observe),
  });
  return model;
}
