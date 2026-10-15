import ts from "typescript";
import { boundaryCases } from "./boundary-cases.mjs";
import {
  boundaryDeclarations,
  broad,
  excluded,
  typed,
} from "./boundary-declarations.mjs";
import {
  callbackReturns,
  enclosingFunction,
  isAssertionChain,
  unwrapExpression,
  wrapperKinds,
} from "./boundary-syntax.mjs";
import {
  declaredOperandType,
  narrowingProvesTarget,
  sameType,
} from "./cast-narrowing-proof.mjs";

const models = new WeakMap();
const logicalOperators = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);
const assertionKinds = new Set([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

function branchesOf(expression) {
  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse];
  }
  if (
    ts.isBinaryExpression(expression) &&
    logicalOperators.has(expression.operatorToken.kind)
  ) {
    return [expression.left, expression.right];
  }
  return null;
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

function unresolvedType(type) {
  return Boolean(type) && type.intrinsicName === "error";
}

export function boundaryModel(program) {
  if (models.has(program)) return models.get(program);
  const checker = program.getTypeChecker();
  const writesBySource = new WeakMap();
  const rootFiles = new Set(program.getRootFileNames());
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

  function memberContract(contract, memberName) {
    if (!contract) return null;
    if (
      contract.flags & ts.TypeFlags.TypeParameter ||
      unresolvedType(contract)
    ) {
      return contract;
    }
    const owner = contract.getNonNullableType();
    const property =
      memberName !== null && checker.getPropertyOfType(owner, memberName);
    if (property) return checker.getTypeOfSymbol(property);
    return (
      checker.getIndexTypeOfType(owner, ts.IndexKind.String) ??
      checker.getIndexTypeOfType(owner, ts.IndexKind.Number) ??
      null
    );
  }

  function withClaim(roots, contract, node) {
    if (
      !contract ||
      !(
        typed(contract, { allowTypeParameter: true }) ||
        unresolvedType(contract)
      )
    ) {
      return roots;
    }
    return roots.map((root) =>
      root.decoded || root.incomplete
        ? root
        : {
            ...root,
            claim: {
              contract: root.field
                ? memberContract(contract, root.field)
                : contract,
              node,
            },
          }
    );
  }

  function memberKey(expression) {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    const key = expression.argumentExpression;
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
      ? key.text
      : null;
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
    const assignments = (writes(use.getSourceFile()).get(symbol) ?? []).filter(
      (assignment) =>
        nestedUse
          ? enclosingFunction(assignment) === declaringFunction
          : assignment.end < use.pos &&
            enclosingFunction(assignment) === enclosingFunction(use)
    );
    const last = nestedUse
      ? undefined
      : assignments.findLast((assignment) =>
          unconditionalBefore(assignment, use)
        );
    const expressions = [];
    if (last) expressions.push(last.right);
    else if (declaration.initializer) expressions.push(declaration.initializer);
    for (const assignment of assignments) {
      if (!last || assignment.pos > last.pos) {
        expressions.push(assignment.right);
      }
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

  const RETURNED_FUNCTION_DEPTH = 8;

  function typeParameters(
    type,
    collected = new Set(),
    visited = new Set(),
    depth = 0
  ) {
    if (!type || visited.has(type) || depth > RETURNED_FUNCTION_DEPTH) {
      return collected;
    }
    visited.add(type);
    if (type.flags & ts.TypeFlags.TypeParameter) collected.add(type);
    const members = type.isUnionOrIntersection() ? type.types : [];
    for (const member of [...members, ...checker.getTypeArguments(type)]) {
      typeParameters(member, collected, visited, depth);
    }
    for (const signature of type.getCallSignatures()) {
      typeParameters(
        checker.getReturnTypeOfSignature(signature),
        collected,
        visited,
        depth + 1
      );
    }
    return collected;
  }

  function forwardedRoots(call, signature, flow) {
    const output = typeParameters(checker.getReturnTypeOfSignature(signature));
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
          [...typeParameters(checker.getReturnTypeOfSignature(callback))].some(
            (candidate) => output.has(candidate)
          )
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
    const owner = signature.declaration?.parent;
    const receiverParameters =
      owner?.typeParameters?.map((parameter) =>
        checker.getTypeAtLocation(parameter)
      ) ?? [];
    if (
      (receiverParameters.some((parameter) => output.has(parameter)) ||
        (!output.size &&
          (ts.isMethodSignature(signature.declaration) ||
            ts.isMethodDeclaration(signature.declaration)))) &&
      ts.isPropertyAccessExpression(call.expression)
    ) {
      const returned = checker.getReturnTypeOfSignature(signature);
      const projection =
        !output.size &&
        origin(signature.declaration, call) === "platform" &&
        typed(returned) &&
        !broadPayload(returned);
      roots.push(
        ...trace(call.expression.expression, {
          ...flow,
          visited: new Set(flow.visited),
        }).map((root) =>
          projection && !root.incomplete ? { ...root, opaque: false } : root
        )
      );
    }
    return roots;
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
    return Boolean(
      sourceOpaque || broad(declaredOutput) || typeParameters(rawOutput).size
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
        field: undefined,
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

  function implementationRoots(call, implementation, flow) {
    const nextBindings = new Map(flow.bindings);
    for (const [index, parameter] of implementation.parameters.entries()) {
      if (call.arguments[index]) {
        nextBindings.set(parameter, call.arguments[index]);
      }
    }
    return withClaim(
      callbackReturns(implementation).flatMap((expression) =>
        trace(expression, {
          ...flow,
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
    const key = memberKey(expression);
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
      const key = memberKey(expression);
      return carrierMemberRoots(expression, inherited, receiverType)
        .filter((root) => !root.field || root.field === key)
        .map((root) => ({
          ...root,
          field: undefined,
          overrides: undefined,
          claim: root.claim && {
            ...root.claim,
            contract: root.field
              ? root.claim.contract
              : memberContract(root.claim.contract, key),
          },
        }));
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

  function objectRoots(expression, flow) {
    const names = expression.properties.map((property) =>
      ts.isSpreadAssignment(property)
        ? null
        : property.name?.getText(expression.getSourceFile())
    );
    return expression.properties.flatMap((property, position) => {
      const nested = { ...flow, visited: new Set(flow.visited) };
      if (ts.isSpreadAssignment(property)) {
        const overrides = new Set(names.slice(position + 1).filter(Boolean));
        return trace(property.expression, nested).map((root) => ({
          ...root,
          overrides,
        }));
      }
      if (ts.isPropertyAssignment(property)) {
        const field = names[position];
        return trace(property.initializer, nested).map((root) => ({
          ...root,
          field,
        }));
      }
      if (!ts.isShorthandPropertyAssignment(property)) return [];
      const field = property.name.text;
      const declarations =
        checker.getShorthandAssignmentValueSymbol(property)?.declarations ?? [];
      return declarations.flatMap((declaration) =>
        bindingRoots(declaration, { ...nested, use: property }).map((root) => ({
          ...root,
          field,
        }))
      );
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
    const roots = traceExpression(expression, flow);
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

  function unprovedNarrowing(expression) {
    const owner = enclosingFunction(expression);
    const symbol = checker.getSymbolAtLocation(expression);
    if (!owner?.body || !symbol) return false;
    function visit(node) {
      if (ts.isFunctionLike(node) || node.pos >= expression.pos) return false;
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const predicate =
          signature && checker.getTypePredicateOfSignature(signature);
        const subject = predicate && node.arguments[predicate.parameterIndex];
        if (
          subject &&
          checker.getSymbolAtLocation(subject) === symbol &&
          !decode(node)
        ) {
          return true;
        }
      }
      return ts.forEachChild(node, visit);
    }
    return Boolean(visit(owner.body));
  }

  function narrowingOccurred(node) {
    const unwrapped = unwrapExpression(node);
    if (!unwrapped) return false;
    const branches = branchesOf(unwrapped);
    if (branches) {
      return branches.every(
        (branch) => !trace(branch).length || narrowingOccurred(branch)
      );
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return unwrapped.properties.every((property) => {
        if (ts.isPropertyAssignment(property)) {
          return (
            !trace(property.initializer).length ||
            narrowingOccurred(property.initializer)
          );
        }
        return (
          ts.isShorthandPropertyAssignment(property) &&
          narrowingOccurred(property.name)
        );
      });
    }
    const flow = checker.getTypeAtLocation(unwrapped);
    const declared = declaredOperandType(checker, unwrapped, flow);
    return Boolean(declared) && !sameType(checker, declared, flow);
  }

  function activeRoots(expression) {
    const source = expression.getSourceFile();
    const preamble = source.text.slice(
      0,
      Math.min(source.statements[0]?.pos ?? 2048, 4096)
    );
    const generatedFile =
      /^\s*(?:\/\/|\/\*+|\*+)?\s*(?:@generated\b|Code generated .* DO NOT EDIT\.|This file was generated by\b|Generated by\b)/mu.test(
        preamble
      );
    if (excluded({ generatedFile })) return [];
    return trace(expression).filter(
      (root) =>
        !excluded({
          decoded: root.decoded,
          unopenedString: Boolean(root.activation),
          castChain: root.castChain,
        })
    );
  }

  function demandedFields(target) {
    const nonNull = target.getNonNullableType();
    if (
      !(nonNull.flags & ts.TypeFlags.Object) ||
      checker.isArrayLikeType(nonNull) ||
      checker.getIndexInfosOfType(nonNull).length
    ) {
      return null;
    }
    const properties = checker.getPropertiesOfType(nonNull);
    return properties.length
      ? new Set(properties.map((property) => property.name))
      : null;
  }

  function demandedBy(root, target) {
    const demanded = demandedFields(target);
    if (!demanded) return true;
    if (root.field) return demanded.has(root.field);
    if (root.overrides) {
      return [...demanded].some((name) => !root.overrides.has(name));
    }
    return true;
  }

  function claimCovers(root, target, claimNode) {
    const claim = root.claim;
    if (!claim || !claim.contract || claim.node === claimNode) return false;
    if (!rootFiles.has(claim.node.getSourceFile().fileName)) return false;
    if (
      unresolvedType(claim.contract) ||
      claim.contract.flags & ts.TypeFlags.TypeParameter
    ) {
      return true;
    }
    const demanded =
      (root.field && memberContract(target, root.field)) || target;
    return narrowingProvesTarget(checker, claim.contract, demanded);
  }

  function unchecked(expression, target, options = {}) {
    if (options.opaqueOnly) {
      if (!(checker.getTypeAtLocation(expression)?.flags & ts.TypeFlags.Any)) {
        return [];
      }
      return activeRoots(expression).filter((root) => Boolean(root.opaque));
    }
    if (unresolvedType(target)) {
      return activeRoots(expression)
        .filter(
          (root) =>
            !excluded({ claimed: claimCovers(root, target, options.claimNode) })
        )
        .map((root) => ({
          ...root,
          incomplete: root.incomplete ?? "unresolved contract type",
        }));
    }
    if (excluded({ acceptsUnknown: !typed(target, options) })) return [];
    const roots = activeRoots(expression).filter(
      (root) =>
        !excluded({
          undemanded: !demandedBy(root, target),
          claimed: claimCovers(root, target, options.claimNode),
        })
    );
    if (!roots.length) return [];
    const proves = pathProves(expression, target);
    const intactCarrier =
      proves && roots.every((root) => root.pending && !root.incomplete);
    const narrowed = roots.every((root) =>
      rootNarrowed(root, expression, target)
    );
    if (excluded({ intactCarrier, narrowed })) return [];
    return roots;
  }

  function pathProves(site, target) {
    const rawActual = checker.getTypeAtLocation(site);
    const actual = ts.isReturnStatement(site.parent)
      ? (checker.getAwaitedType(rawActual) ?? rawActual)
      : rawActual;
    return Boolean(actual) && narrowingProvesTarget(checker, actual, target);
  }

  function fieldSite(expression, field) {
    const unwrapped = unwrapExpression(expression);
    if (!field || !unwrapped || !ts.isObjectLiteralExpression(unwrapped)) {
      return null;
    }
    const property = unwrapped.properties.find(
      (candidate) =>
        !ts.isSpreadAssignment(candidate) &&
        candidate.name?.getText(unwrapped.getSourceFile()) === field
    );
    if (!property) return null;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    return ts.isShorthandPropertyAssignment(property) ? property.name : null;
  }

  function rootNarrowed(root, expression, target) {
    const site = fieldSite(expression, root.field);
    const demanded = site
      ? (memberContract(target, root.field) ?? target)
      : target;
    return (
      pathProves(site ?? expression, demanded) &&
      !unprovedNarrowing(site ?? expression) &&
      (!root.opaque || narrowingOccurred(site ?? expression))
    );
  }

  function argumentType(call, index) {
    const signature = checker.getResolvedSignature(call);
    if (!signature) return null;
    const parameter =
      signature.parameters[Math.min(index, signature.parameters.length - 1)];
    if (!parameter) return null;
    const instantiated = checker.getTypeOfSymbolAtLocation(parameter, call);
    const declaredParameter = parameter.valueDeclaration;
    const declared =
      declaredParameter &&
      ts.isParameter(declaredParameter) &&
      declaredParameter.type &&
      checker.getTypeFromTypeNode(declaredParameter.type);
    const contract =
      broad(instantiated) && declared?.flags & ts.TypeFlags.TypeParameter
        ? (checker.getBaseConstraintOfType(declared) ?? instantiated)
        : instantiated;
    if (!declaredParameter?.dotDotDotToken) return contract;
    if (checker.isTupleType(contract)) {
      return checker.getTypeArguments(contract)[
        index - signature.parameters.length + 1
      ];
    }
    return checker.getIndexTypeOfType(contract, ts.IndexKind.Number);
  }

  function ownedByCastChain(expression) {
    let current = expression;
    while (
      current &&
      (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current))
    ) {
      current = current.expression;
    }
    return Boolean(current) && isAssertionChain(current);
  }

  function assertionSink(assertion) {
    if (
      isAssertionChain(assertion) ||
      assertionKinds.has(assertion.parent.kind)
    ) {
      return [];
    }
    return unchecked(
      assertion.expression,
      checker.getTypeAtLocation(assertion),
      {
        allowTypeParameter: true,
        claimNode: assertion,
      }
    );
  }

  function declarationSink(declaration) {
    if (!declaration.initializer || ownedByCastChain(declaration.initializer)) {
      return [];
    }
    if (declaration.type) {
      return unchecked(
        declaration.initializer,
        checker.getTypeFromTypeNode(declaration.type),
        { claimNode: declaration }
      );
    }
    if (
      ts.isObjectBindingPattern(declaration.name) ||
      ts.isArrayBindingPattern(declaration.name)
    ) {
      return unchecked(declaration.initializer, null, { opaqueOnly: true });
    }
    return [];
  }

  function assignmentSink(assignment) {
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      ownedByCastChain(assignment.right)
    ) {
      return [];
    }
    return unchecked(
      assignment.right,
      checker.getTypeAtLocation(assignment.left)
    );
  }

  function returnSink(statement) {
    if (!statement.expression || ownedByCastChain(statement.expression))
      return [];
    const owner = enclosingFunction(statement);
    if (!owner?.type) return [];
    return unchecked(
      statement.expression,
      checker.getAwaitedType(checker.getTypeFromTypeNode(owner.type)),
      { claimNode: owner }
    );
  }

  function typeArgumentSink(call) {
    if (
      !call.typeArguments?.length ||
      !checker.getResolvedSignature(call) ||
      decode(call) ||
      !trace(call).some((root) => root.root === call)
    ) {
      return [];
    }
    return unchecked(call, checker.getTypeFromTypeNode(call.typeArguments[0]), {
      allowTypeParameter: true,
      claimNode: call,
    });
  }

  const sinks = {
    [ts.SyntaxKind.AsExpression]: assertionSink,
    [ts.SyntaxKind.TypeAssertionExpression]: assertionSink,
    [ts.SyntaxKind.VariableDeclaration]: declarationSink,
    [ts.SyntaxKind.BinaryExpression]: assignmentSink,
    [ts.SyntaxKind.ReturnStatement]: returnSink,
    [ts.SyntaxKind.CallExpression]: typeArgumentSink,
  };

  function uncheckedAt(node) {
    const sink = sinks[node.kind];
    return sink ? sink(node) : [];
  }

  function uncheckedArgument(argument) {
    const call = argument.parent;
    if (
      !call?.arguments?.includes(argument) ||
      !(ts.isCallExpression(call) || ts.isNewExpression(call)) ||
      ownedByCastChain(argument) ||
      !checker.getResolvedSignature(call) ||
      (ts.isCallExpression(call) && decode(call))
    ) {
      return [];
    }
    return unchecked(
      argument,
      argumentType(call, call.arguments.indexOf(argument))
    );
  }

  const model = { trace, decode, uncheckedAt, uncheckedArgument };
  models.set(program, model);
  return model;
}
