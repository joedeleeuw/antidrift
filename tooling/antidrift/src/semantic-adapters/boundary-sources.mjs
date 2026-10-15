import ts from "typescript";
import { boundaryCases } from "./boundary-cases.mjs";
import { broad, excluded } from "./boundary-declarations.mjs";
import { unwrapExpression } from "./boundary-syntax.mjs";

const writeOperators = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

export function boundarySources({ checker, declarations, hasRoots }) {
  const { callsInSource, carrierPath, exported, origin, platformSource } =
    declarations;
  const writesBySource = new WeakMap();
  const callersBySource = new WeakMap();

  function writes(source) {
    if (writesBySource.has(source)) return writesBySource.get(source);
    const assignments = new Map();
    function visit(node) {
      if (
        ts.isBinaryExpression(node) &&
        writeOperators.has(node.operatorToken.kind)
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

  function callersOf(declaration) {
    const source = declaration.getSourceFile();
    let callers = callersBySource.get(source);
    if (!callers) {
      callers = new Map();
      for (const call of callsInSource(source)) {
        const callee = checker.getResolvedSignature(call)?.declaration;
        if (!callee) continue;
        const entries = callers.get(callee) ?? [];
        entries.push(call);
        callers.set(callee, entries);
      }
      callersBySource.set(source, callers);
    }
    return callers.get(declaration) ?? [];
  }

  function exportedParameterRoots(parameter, declared) {
    const row = boundaryCases.roots.find(
      (candidate) =>
        candidate.exported &&
        (candidate.parameter === "unknown"
          ? declared.flags & ts.TypeFlags.Unknown
          : declared.flags & ts.TypeFlags.String)
    );
    if (!row) return [];
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
        .map((signature) => signature.parameters[index])
        .filter(Boolean)
        .map((symbol) => ({
          subjectType: checker.getTypeOfSymbol(symbol),
          declarations: symbol.declarations ?? [],
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
    return candidates.flatMap(({ subjectType, declarations: subjects }) => {
      const declaration = subjects.find(
        (contract) => origin(contract, expression) === "dependency"
      );
      return declaration ? [{ subjectType, declaration }] : [];
    });
  }

  function frameworkRootOf(carrier, expression) {
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

  function frameworkRoot(expression) {
    const carrier = carrierPath(expression);
    if (!carrier || carrier.deserialized) return null;
    return frameworkRootOf(carrier, expression);
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
        !hasRoots(unwrapped.arguments[0])
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
      const calls = callersOf(declaration.parent);
      return (
        calls.length > 0 &&
        calls.every((call) =>
          localString(call.arguments?.[index], new Set(visited))
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

  function memberSourceRoots(expression, receiverType) {
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

  function bindingSourceRoots(element, receiverType, keys, carrier) {
    const request = carrier && frameworkRootOf(carrier, element);
    if (request) return [request];
    if (!receiverType || !keys) return [];
    for (const key of keys) {
      const property = checker.getPropertyOfType(
        receiverType.getNonNullableType(),
        key
      );
      for (const declaration of property?.declarations ?? []) {
        const source = platformSource(declaration);
        if (source) {
          const opaque = Boolean(
            source.opaque || broad(checker.getTypeAtLocation(element))
          );
          return [{ kind: source.kind, root: element, declaration, opaque }];
        }
      }
    }
    return [];
  }

  return {
    bindingSourceRoots,
    callersOf,
    exportedParameterRoots,
    frameworkRoot,
    incompleteCause,
    localReceiver,
    localString,
    memberSourceRoots,
    writes,
  };
}
