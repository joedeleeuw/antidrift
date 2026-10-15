import ts from "typescript";
import { boundaryCases } from "./boundary-cases.mjs";
import {
  ELEMENT,
  assertionKinds,
  contractProjection,
  logicalOperators,
  unresolvedType,
} from "./boundary-contracts.mjs";
import {
  boundaryDeclarations,
  broad,
  excluded,
  typed,
} from "./boundary-declarations.mjs";
import { boundarySinks } from "./boundary-sinks.mjs";
import {
  callbackReturns,
  enclosingFunction,
  isAssertionChain,
  unwrapExpression,
  wrapperKinds,
} from "./boundary-syntax.mjs";

const models = new WeakMap();
const RETURNED_FUNCTION_DEPTH = 16;
const IMPLEMENTATION_DEPTH = 4;
const INLINING_BUDGET = 1024;

function nodeKey(node) {
  return `${node.getSourceFile().fileName}:${node.pos}-${node.end}:${node.kind}`;
}

function prefixed(root, step) {
  return step === null ? root : { ...root, path: [step, ...(root.path ?? [])] };
}

function contains(ancestor, node) {
  return ancestor.pos <= node.pos && ancestor.end >= node.end;
}

function unconditionalBefore(write, use) {
  if (write.end >= use.pos) return false;
  let ancestor = write.parent;
  while (ancestor && !ts.isFunctionLike(ancestor)) {
    if (
      (ts.isBlock(ancestor) ||
        ts.isIfStatement(ancestor) ||
        ts.isConditionalExpression(ancestor) ||
        ts.isIterationStatement(ancestor, false)) &&
      !contains(ancestor, use)
    ) {
      return false;
    }
    ancestor = ancestor.parent;
  }
  return ancestor === enclosingFunction(use);
}

export function boundaryModel(program) {
  if (models.has(program)) return models.get(program);
  const checker = program.getTypeChecker();
  const writesBySource = new WeakMap();
  const contracts = contractProjection(checker);
  const {
    accessKey,
    claimContract,
    memberContract,
    projectContract,
    propertyKey,
  } = contracts;
  const {
    callsInSource,
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
  } = boundaryDeclarations(program);

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

  function withClaim(roots, contract, node) {
    const claimed = claimContract(contract);
    if (!claimed) return roots;
    return roots.map((root) =>
      root.decoded || root.incomplete
        ? root
        : {
            ...root,
            claim: { contract: projectContract(claimed, root.path), node },
          }
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

  function callbackUpstreamCandidates(parameter, call) {
    const candidates = call.arguments.filter(
      (argument) => argument !== parameter.parent
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

  function contextualParameterRoots(parameter, index, visited) {
    const ownerFn = parameter.parent;
    if (!ts.isExpression(ownerFn)) return [];
    const contextual = checker.getContextualType(ownerFn);
    for (const signature of contextual
      ?.getNonNullableType()
      .getCallSignatures() ?? []) {
      const subject = signature.parameters[index];
      for (const declaration of subject?.declarations ?? []) {
        const source = platformSource(declaration);
        if (source) {
          const opaque = Boolean(
            source.opaque || broad(checker.getTypeOfSymbol(subject))
          );
          return [{ kind: source.kind, root: parameter, declaration, opaque }];
        }
        const contract =
          declaration.type && checker.getTypeFromTypeNode(declaration.type);
        if (
          contract?.flags & ts.TypeFlags.TypeParameter &&
          ts.isCallExpression(ownerFn.parent)
        ) {
          return callbackUpstreamCandidates(parameter, ownerFn.parent).flatMap(
            (candidate) =>
              trace(candidate, { use: parameter, visited: new Set(visited) })
          );
        }
      }
    }
    return [];
  }

  function parameterRoot(parameter, flow) {
    const declared =
      parameter.type && checker.getTypeFromTypeNode(parameter.type);
    if (flow.bindings?.has(parameter)) {
      return withClaim(
        trace(flow.bindings.get(parameter), {
          ...flow,
          visited: new Set(flow.visited),
        }),
        declared,
        parameter
      );
    }
    if (flow.visited.has(parameter)) return [];
    flow.visited.add(parameter);
    const ownerFn = parameter.parent;
    const signature = checker.getSignatureFromDeclaration(ownerFn);
    const decoder = signatureDecode(signature, parameter);
    const index = ownerFn.parameters.indexOf(parameter);
    if (excluded({ decoderSubject: decoder?.parameter === index })) return [];
    if (declared && exported(ownerFn)) {
      const row = boundaryCases.roots.find(
        (candidate) =>
          candidate.exported &&
          (candidate.parameter === "unknown"
            ? declared.flags & ts.TypeFlags.Unknown
            : declared.flags & ts.TypeFlags.String)
      );
      if (row) {
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
    }
    if (!exported(ownerFn)) {
      const localRoots = callsInSource(parameter.getSourceFile())
        .filter(
          (call) =>
            checker.getResolvedSignature(call)?.declaration === ownerFn &&
            call.arguments[index]
        )
        .flatMap((call) =>
          trace(call.arguments[index], {
            ...flow,
            visited: new Set(flow.visited),
          })
        );
      if (localRoots.length) return withClaim(localRoots, declared, parameter);
    }
    return contextualParameterRoots(parameter, index, flow.visited);
  }

  function writes(source) {
    if (writesBySource.has(source)) return writesBySource.get(source);
    const assignments = new Map();
    function visit(node) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) {
          const entries = assignments.get(symbol) ?? [];
          entries.push(node);
          assignments.set(symbol, entries);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    writesBySource.set(source, assignments);
    return assignments;
  }

  function bindingRoots(declaration, flow) {
    const { use, visited } = flow;
    if (ts.isParameter(declaration)) return parameterRoot(declaration, flow);
    if (ts.isBindingElement(declaration)) {
      let binding = declaration.parent;
      while (!ts.isVariableDeclaration(binding) && !ts.isParameter(binding)) {
        binding = binding.parent;
      }
      return bindingRoots(binding, flow);
    }
    if (!ts.isVariableDeclaration(declaration)) return [];
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const declaringFunction = enclosingFunction(declaration);
    const nestedUse = declaringFunction !== enclosingFunction(use);
    const assignments = writes(use.getSourceFile()).get(symbol) ?? [];
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
      : direct.findLast((assignment) => unconditionalBefore(assignment, use));
    const expressions = [];
    if (last) expressions.push(last.right);
    else if (declaration.initializer) expressions.push(declaration.initializer);
    for (const assignment of direct) {
      if (!last || assignment.pos > last.pos) {
        expressions.push(assignment.right);
      }
    }
    for (const assignment of closureWrites) {
      expressions.push(assignment.right);
    }
    return withClaim(
      expressions.flatMap((expression) =>
        trace(expression, { ...flow, visited: new Set(visited) })
      ),
      declaration.type && checker.getTypeFromTypeNode(declaration.type),
      declaration
    );
  }

  function handlerSubjects(parameter, expression) {
    const parent = parameter.parent;
    const index = parent.parameters.indexOf(parameter);
    const signatures = ts.isExpression(parent)
      ? (checker
          .getContextualType(parent)
          ?.getNonNullableType()
          .getCallSignatures() ?? [])
      : [];
    const explicit = checker.getTypeAtLocation(parameter)?.getNonNullableType();
    const candidates = [
      ...signatures
        .map((sig) => sig.parameters[index])
        .filter(Boolean)
        .map((sym) => ({
          subjectType: checker.getTypeOfSymbol(sym),
          declarations: sym.declarations ?? [],
        })),
      ...(explicit
        ? [
            {
              subjectType: explicit,
              declarations: [
                ...(explicit.symbol?.declarations ?? []),
                ...(explicit.aliasSymbol?.declarations ?? []),
              ],
            },
          ]
        : []),
    ];
    return candidates.flatMap(({ subjectType, declarations }) => {
      const declaration = declarations.find(
        (contract) => origin(contract, expression) === "dependency"
      );
      return declaration ? [{ subjectType, declaration }] : [];
    });
  }

  function frameworkRoot(expression) {
    const carrier = carrierPath(expression);
    if (!carrier || carrier.deserialized) return null;
    for (const { subjectType, declaration } of handlerSubjects(
      carrier.parameter,
      expression
    )) {
      const upstreamContract = boundaryCases.exclusions.some(
        (row) =>
          row.required &&
          row.payloads.includes(carrier.path[0]) &&
          row.required.every((name) =>
            checker.getPropertyOfType(subjectType, name)
          )
      );
      if (excluded({ upstreamContract })) return null;
      for (const shape of boundaryCases.frameworks) {
        if (carrier.path.length <= shape.path.length) continue;
        if (
          !shape.path.every(
            (segment, position) => carrier.path[position] === segment
          )
        ) {
          continue;
        }
        let receiver = subjectType;
        for (const segment of shape.path) {
          const member = checker.getPropertyOfType(receiver, segment);
          receiver = member && checker.getTypeOfSymbol(member);
          if (!receiver) break;
        }
        if (
          !receiver ||
          !shape.required.every((name) =>
            checker.getPropertyOfType(receiver, name)
          )
        ) {
          continue;
        }
        if (shape.payloads.includes(carrier.path[shape.path.length])) {
          const opaque = broad(checker.getTypeAtLocation(expression));
          return { kind: shape.kind, root: expression, declaration, opaque };
        }
      }
    }
    return null;
  }

  function localReceiver(expression, visited = new Set()) {
    if (visited.has(expression)) return null;
    visited.add(expression);
    if (ts.isNewExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return null;
    for (const declaration of checker.getSymbolAtLocation(expression)
      ?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return localReceiver(declaration.initializer, visited);
      }
    }
    return null;
  }

  function localString(expression, visited = new Set()) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) return false;
    visited.add(unwrapped);
    if (
      ts.isStringLiteral(unwrapped) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped)
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return unwrapped.elements.every((element) =>
        localString(element, new Set(visited))
      );
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return unwrapped.templateSpans.every((span) =>
        localString(span.expression, new Set(visited))
      );
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return (
        localString(unwrapped.left, new Set(visited)) &&
        localString(unwrapped.right, new Set(visited))
      );
    }
    if (ts.isCallExpression(unwrapped)) {
      const construction =
        ts.isPropertyAccessExpression(unwrapped.expression) &&
        localReceiver(unwrapped.expression.expression);
      if (construction) {
        return (construction.arguments ?? []).every((argument) =>
          localString(argument, new Set(visited))
        );
      }
      const declaration = checker.getResolvedSignature(unwrapped)?.declaration;
      return Boolean(
        declaration &&
        origin(declaration, unwrapped) === "platform" &&
        declaration.name?.getText(declaration.getSourceFile()) ===
          "stringify" &&
        unwrapped.arguments[0] &&
        !trace(unwrapped.arguments[0]).length
      );
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    const symbol = checker.getSymbolAtLocation(unwrapped);
    if ((writes(unwrapped.getSourceFile()).get(symbol) ?? []).length) {
      return false;
    }
    return (symbol?.declarations ?? []).some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return localString(declaration.initializer, visited);
      }
      if (!ts.isParameter(declaration) || exported(declaration.parent)) {
        return false;
      }
      const index = declaration.parent.parameters.indexOf(declaration);
      const calls = callsInSource(unwrapped.getSourceFile()).filter(
        (call) =>
          checker.getResolvedSignature(call)?.declaration === declaration.parent
      );
      return (
        calls.length > 0 &&
        calls.every((call) =>
          localString(call.arguments[index], new Set(visited))
        )
      );
    });
  }

  function incompleteCause(expression) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped) return "unresolved-provenance";
    if (ts.isCallExpression(unwrapped)) return "untracked-call-return";
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return "untracked-member-or-element";
    }
    if (ts.isIdentifier(unwrapped)) {
      const symbol = checker.getSymbolAtLocation(unwrapped);
      if ((writes(unwrapped.getSourceFile()).get(symbol) ?? []).length) {
        return "cross-callback-mutation";
      }
      for (const declaration of symbol?.declarations ?? []) {
        if (ts.isParameter(declaration)) return "untracked-parameter";
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          return incompleteCause(declaration.initializer);
        }
      }
    }
    return "unresolved-provenance";
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

  function forwardedRoots(call, signature, flow) {
    const { typeParameters: output, truncated } = returnedTypeParameters(
      checker.getReturnTypeOfSignature(signature)
    );
    const roots = [];
    for (const [index, parameter] of signature.parameters.entries()) {
      const argument = call.arguments[index];
      if (!argument) continue;
      const contract = checker.getTypeOfSymbol(parameter);
      if (output.has(contract)) {
        roots.push(
          ...trace(argument, { ...flow, visited: new Set(flow.visited) })
        );
      }
      const callbacks = callbackNodes(argument);
      const sharesOutput = contract
        .getNonNullableType()
        .getCallSignatures()
        .some((callback) =>
          [
            ...returnedTypeParameters(
              checker.getReturnTypeOfSignature(callback)
            ).typeParameters,
          ].some((candidate) => output.has(candidate))
        );
      if (
        callbacks.length &&
        (sharesOutput || ts.isObjectLiteralExpression(argument))
      ) {
        for (const callback of callbacks) {
          for (const expression of callbackReturns(callback)) {
            roots.push(
              ...trace(expression, { ...flow, visited: new Set(flow.visited) })
            );
          }
        }
      }
      if (sharesOutput && ts.isCallExpression(argument)) {
        roots.push(
          ...trace(argument, { ...flow, visited: new Set(flow.visited) })
        );
      }
    }
    roots.push(...receiverRoots(call, signature, output, flow));
    if (truncated) roots.push(...truncatedRoots(call, signature, output));
    return roots;
  }

  function receiverRoots(call, signature, output, flow) {
    const { declaration } = signature;
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
    return trace(call.expression.expression, {
      ...flow,
      visited: new Set(flow.visited),
    }).map((root) =>
      projection && !root.incomplete ? { ...root, opaque: false } : root
    );
  }

  function truncatedRoots(call, signature, output) {
    return signature.parameters.flatMap((parameter, index) => {
      const unsettled =
        call.arguments[index] &&
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

  function calleeImplementation(call, declaration) {
    if (declaration.body) return declaration;
    const symbol = checker.getSymbolAtLocation(call.expression);
    const target =
      symbol &&
      (symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol);
    for (const node of [declaration.parent, ...(target?.declarations ?? [])]) {
      const candidate =
        node && ts.isVariableDeclaration(node) ? node.initializer : node;
      if (candidate && ts.isFunctionLike(candidate) && candidate.body) {
        return candidate;
      }
    }
    return null;
  }

  function callOpaque(declaration, sourceOpaque) {
    const declaredSignature = checker.getSignatureFromDeclaration(declaration);
    const rawOutput =
      declaredSignature && checker.getReturnTypeOfSignature(declaredSignature);
    const declaredOutput =
      rawOutput && (checker.getPromisedTypeOfPromise(rawOutput) ?? rawOutput);
    const { typeParameters, truncated } = returnedTypeParameters(rawOutput);
    return Boolean(
      sourceOpaque || broad(declaredOutput) || typeParameters.size || truncated
    );
  }

  function typeArgumentClaim(call, roots) {
    const typeArgument = call.typeArguments?.[0];
    return typeArgument
      ? withClaim(roots, checker.getTypeFromTypeNode(typeArgument), call)
      : roots;
  }

  function callResultContract(contract) {
    if (!contract || unresolvedType(contract)) return contract;
    const signature = contract.getNonNullableType().getCallSignatures()[0];
    return signature
      ? checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))
      : null;
  }

  function untypedCalleeRoots(call, flow) {
    return trace(call.expression, { ...flow, visited: new Set(flow.visited) })
      .filter((root) => root.opaque || root.incomplete)
      .map((root) => ({
        ...root,
        root: call,
        path: undefined,
        overrides: undefined,
        claim: root.claim && {
          ...root.claim,
          contract: callResultContract(root.claim.contract),
        },
      }));
  }

  function deserializerRoots(call, source, declaration, flow) {
    const argument = call.arguments[source.argument];
    if (!argument) return [];
    const { kind } = source;
    const upstreamRoots = trace(argument, flow);
    if (upstreamRoots.length) {
      return upstreamRoots.map((upstream) => ({
        kind,
        root: call,
        declaration,
        upstream,
        opaque: true,
      }));
    }
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

  function platformCallRoots(call, source, declaration, flow) {
    const construction =
      ts.isPropertyAccessExpression(call.expression) &&
      localReceiver(call.expression.expression);
    const opaque = callOpaque(declaration, source.opaque);
    if (excluded({ local: Boolean(construction) })) {
      return (construction.arguments ?? [])
        .flatMap((argument) =>
          trace(argument, { ...flow, visited: new Set(flow.visited) })
        )
        .map((upstream) => ({
          kind: source.kind,
          root: call,
          declaration,
          upstream,
          opaque,
        }));
    }
    return typeArgumentClaim(call, [
      { kind: source.kind, root: call, declaration, opaque },
    ]);
  }

  const internedBindings = new Map();

  function bindingsFor(entries) {
    const key = entries
      .map(
        ([parameter, argument]) => `${nodeKey(parameter)}=${nodeKey(argument)}`
      )
      .sort()
      .join("|");
    let bindings = internedBindings.get(key);
    if (!bindings) {
      bindings = new Map(entries);
      internedBindings.set(key, bindings);
    }
    return bindings;
  }

  function callSiteBindings(call, implementation, flow) {
    const bound = new Map(flow.bindings);
    for (const [index, parameter] of implementation.parameters.entries()) {
      if (call.arguments[index]) bound.set(parameter, call.arguments[index]);
    }
    return bindingsFor([...bound]);
  }

  function implementationRoots(call, implementation, flow) {
    if (flow.inlining.remaining <= 0) {
      return [
        {
          kind: "unresolved-declaration",
          root: call,
          declaration: implementation,
          opaque: true,
          incomplete: `more than ${INLINING_BUDGET} first-party implementations inlined for one use`,
        },
      ];
    }
    flow.inlining.remaining -= 1;
    const depth = (flow.depth ?? 0) + 1;
    const nextBindings =
      depth > IMPLEMENTATION_DEPTH
        ? undefined
        : callSiteBindings(call, implementation, flow);
    return withClaim(
      callbackReturns(implementation).flatMap((expression) =>
        trace(expression, {
          ...flow,
          depth,
          bindings: nextBindings,
          visited: new Set(flow.visited),
        })
      ),
      implementation.type &&
        checker.getAwaitedType(
          checker.getTypeFromTypeNode(implementation.type)
        ),
      implementation
    );
  }

  function callRoots(call, flow) {
    const { visited } = flow;
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!declaration) return untypedCalleeRoots(call, flow);
    const source = platformSource(declaration);
    if (source?.requiresProvenance) {
      return deserializerRoots(call, source, declaration, flow);
    }
    if (source) return platformCallRoots(call, source, declaration, flow);
    const evidence = decode(call);
    if (evidence) {
      return trace(evidence.input, flow).map((root) => ({
        ...root,
        decoded: evidence.kind !== "result",
        pending: evidence.kind === "result" ? evidence : undefined,
        opaque: evidence.kind === "result" ? false : root.opaque,
        claim: undefined,
        incomplete: undefined,
      }));
    }
    const request = frameworkRoot(call.expression);
    if (request) {
      return typeArgumentClaim(call, [
        { ...request, root: call, opaque: callOpaque(declaration, false) },
      ]);
    }
    const implementation = calleeImplementation(call, declaration);
    if (implementation && origin(implementation, call) === null) {
      const returned = implementationRoots(call, implementation, flow);
      if (returned.length) return returned;
    }
    const declared = checker.getSignatureFromDeclaration(declaration);
    if (!declared) return [];
    const candidate = signatureForm(declared);
    const forwarded = forwardedRoots(call, declared, flow);
    if (candidate && call.arguments[candidate.parameter]) {
      const stringProjection =
        origin(declaration, call) === "platform" &&
        Boolean(candidate.output.flags & ts.TypeFlags.StringLike);
      forwarded.push(
        ...trace(call.arguments[candidate.parameter], {
          ...flow,
          visited: new Set(visited),
        }).map((root) =>
          stringProjection
            ? { ...root, opaque: false, activation: "serialized-input" }
            : { ...root, opaque: true }
        )
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

  function derivedThroughAssertion(expression, visited = new Set()) {
    const unwrapped = unwrapExpression(expression);
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

  function carrierMemberRoots(expression, inherited, receiverType) {
    const key = accessKey(expression);
    return inherited.flatMap((root) => {
      if (!root.pending) return [root];
      const { carrier } = root.pending;
      if (key !== carrier.payload) return [];
      const proved =
        narrowedToSuccess(receiverType, carrier) &&
        !derivedThroughAssertion(expression.expression);
      return [
        { ...root, pending: undefined, decoded: proved, opaque: !proved },
      ];
    });
  }

  function unresolvedReceiverRoot(expression) {
    let receiver = unwrapExpression(expression.expression);
    while (
      receiver &&
      (ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver))
    ) {
      receiver = unwrapExpression(receiver.expression);
    }
    if (
      !receiver ||
      !ts.isIdentifier(receiver) ||
      checker.getSymbolAtLocation(receiver)
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

  function memberRoots(expression, flow) {
    const inherited = trace(expression.expression, flow);
    const receiverType = checker.getTypeAtLocation(expression.expression);
    if (inherited.length) {
      const key = accessKey(expression);
      const elementKey = key === null || /^\d+$/u.test(key);
      return carrierMemberRoots(expression, inherited, receiverType).flatMap(
        (root) => {
          if (!root.path?.length) {
            if (root.overrides?.has(key)) return [];
            return [
              {
                ...root,
                overrides: undefined,
                claim: root.claim && {
                  ...root.claim,
                  contract: memberContract(root.claim.contract, key),
                },
              },
            ];
          }
          const [step, ...rest] = root.path;
          const matches = step === ELEMENT ? elementKey : step === key;
          return matches
            ? [{ ...root, path: rest.length ? rest : undefined }]
            : [];
        }
      );
    }
    const request = frameworkRoot(expression);
    if (request) return [request];
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression
    );
    for (const declaration of symbol?.declarations ?? []) {
      const source = platformSource(declaration);
      if (!source) continue;
      const contract =
        declaration.type && checker.getTypeFromTypeNode(declaration.type);
      const receiverArguments =
        receiverType &&
        checker.getTypeArguments(receiverType.getNonNullableType());
      if (
        excluded({
          local: localReceiver(expression.expression),
          narrowed:
            !source.opaque &&
            Boolean(contract?.flags & ts.TypeFlags.TypeParameter) &&
            Boolean(receiverArguments?.length) &&
            !receiverArguments.some(broad),
        })
      ) {
        return [];
      }
      const memberOutput = checker.getAwaitedType(
        checker.getTypeAtLocation(expression)
      );
      const opaque = Boolean(source.opaque || broad(memberOutput));
      return [{ kind: source.kind, root: expression, declaration, opaque }];
    }
    for (const index of checker.getIndexInfosOfType(receiverType)) {
      const source = index.declaration && platformSource(index.declaration);
      if (source) {
        const declaration = index.declaration;
        return [
          {
            kind: source.kind,
            root: expression,
            declaration,
            opaque: Boolean(source.opaque),
          },
        ];
      }
    }
    return unresolvedReceiverRoot(expression);
  }

  function writtenKeys(property) {
    if (!ts.isSpreadAssignment(property)) {
      const key = propertyKey(property);
      return key === null ? [] : [key];
    }
    const spread = checker
      .getTypeAtLocation(property.expression)
      .getNonNullableType();
    return checker
      .getPropertiesOfType(spread)
      .filter((member) => !(member.flags & ts.SymbolFlags.Optional))
      .map((member) => member.name);
  }

  function propertyRoots(property, flow) {
    if (ts.isSpreadAssignment(property)) {
      return trace(property.expression, flow);
    }
    const field = propertyKey(property);
    if (ts.isPropertyAssignment(property)) {
      return trace(property.initializer, flow).map((root) =>
        prefixed(root, field)
      );
    }
    if (!ts.isShorthandPropertyAssignment(property)) return [];
    const declarations =
      checker.getShorthandAssignmentValueSymbol(property)?.declarations ?? [];
    return declarations.flatMap((declaration) =>
      bindingRoots(declaration, { ...flow, use: property }).map((root) =>
        prefixed(root, field)
      )
    );
  }

  function objectRoots(expression, flow) {
    const written = expression.properties.map(writtenKeys);
    return expression.properties.flatMap((property, position) => {
      const overrides = new Set(written.slice(position + 1).flat());
      const nested = { ...flow, visited: new Set(flow.visited) };
      return propertyRoots(property, nested).flatMap((root) => {
        if (root.path?.length) {
          return overrides.has(root.path[0]) ? [] : [root];
        }
        return [
          {
            ...root,
            overrides: new Set([...(root.overrides ?? []), ...overrides]),
          },
        ];
      });
    });
  }

  function arrayRoots(expression, flow) {
    return expression.elements.flatMap((element) => {
      const nested = { ...flow, visited: new Set(flow.visited) };
      if (ts.isSpreadElement(element)) return trace(element.expression, nested);
      if (ts.isOmittedExpression(element)) return [];
      return trace(element, nested).map((root) => prefixed(root, ELEMENT));
    });
  }

  function assertionRoots(expression, flow) {
    const roots = trace(expression.expression, flow);
    return isAssertionChain(expression)
      ? roots.map((root) => ({ ...root, castChain: true }))
      : withClaim(
          roots,
          checker.getTypeFromTypeNode(expression.type),
          expression
        );
  }

  const tracedByBindings = new WeakMap();
  const unbound = new Map();

  function trace(expression, flow = { use: expression, visited: new Set() }) {
    const { visited } = flow;
    if (!expression || visited.has(expression)) return [];
    const bindings = flow.bindings ?? unbound;
    let traced = tracedByBindings.get(bindings);
    if (!traced) {
      traced = new Map();
      tracedByBindings.set(bindings, traced);
    }
    if (traced.has(expression)) return traced.get(expression);
    visited.add(expression);
    const budgeted = flow.inlining
      ? flow
      : { ...flow, inlining: { remaining: INLINING_BUDGET } };
    const roots = traceExpression(expression, budgeted);
    traced.set(expression, roots);
    return roots;
  }

  function traceExpression(expression, flow) {
    const { visited } = flow;
    if (assertionKinds.has(expression.kind)) {
      return assertionRoots(expression, flow);
    }
    if (wrapperKinds.has(expression.kind)) {
      return expression.expression ? trace(expression.expression, flow) : [];
    }
    if (ts.isCallExpression(expression)) return callRoots(expression, flow);
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      return memberRoots(expression, flow);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return objectRoots(expression, flow);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return arrayRoots(expression, flow);
    }
    if (ts.isConditionalExpression(expression)) {
      return [expression.whenTrue, expression.whenFalse].flatMap((branch) =>
        trace(branch, { ...flow, visited: new Set(visited) })
      );
    }
    if (
      ts.isBinaryExpression(expression) &&
      logicalOperators.has(expression.operatorToken.kind)
    ) {
      return [expression.left, expression.right].flatMap((branch) =>
        trace(branch, { ...flow, visited: new Set(visited) })
      );
    }
    if (!ts.isIdentifier(expression)) return [];
    const declarations =
      checker.getSymbolAtLocation(expression)?.declarations ?? [];
    return declarations.flatMap((declaration) =>
      bindingRoots(declaration, { ...flow, use: expression })
    );
  }

  const { uncheckedAt, uncheckedArgument } = boundarySinks({
    program,
    checker,
    trace,
    decode,
    unprovedNarrowing,
    contracts,
  });

  const model = { trace, decode, uncheckedAt, uncheckedArgument };
  models.set(program, model);
  return model;
}
