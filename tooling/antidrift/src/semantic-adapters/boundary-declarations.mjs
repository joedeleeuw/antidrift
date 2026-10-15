import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { boundaryCases } from "./boundary-cases.mjs";
import { boundaryObservations } from "./boundary-observations.mjs";
import {
  callbackReturns,
  enclosingFunction,
  unwrapExpression,
  wrapperKinds,
} from "./boundary-syntax.mjs";

const packageManifest = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(),
  optionalDependencies: z.record(z.string()).optional(),
});

function readManifest(filename) {
  try {
    return packageManifest.parse(JSON.parse(readFileSync(filename, "utf8")));
  } catch (cause) {
    throw new Error(
      `Boundary model: invalid package manifest ${filename}: ${cause.message}`,
      { cause }
    );
  }
}

const broadFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

export function broad(type) {
  return Boolean(type && type.flags & broadFlags);
}

function shapeless(type) {
  if (type.flags & ts.TypeFlags.NonPrimitive) return true;
  return Boolean(
    type.flags & ts.TypeFlags.Object &&
    !type.getProperties().length &&
    !type.getCallSignatures().length &&
    !type.getConstructSignatures().length &&
    !type.getStringIndexType() &&
    !type.getNumberIndexType()
  );
}

export function typed(type, options = {}) {
  if (!type) return false;
  const disallowed =
    broadFlags |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never |
    (options.allowTypeParameter ? 0 : ts.TypeFlags.TypeParameter);
  return !(type.flags & disallowed) && !shapeless(type);
}

export function excluded(facts) {
  return boundaryCases.exclusions.some((exclusion) => facts[exclusion.fact]);
}

function rowMatchesOwner(row, packageName) {
  return Boolean(
    packageName &&
    (row.owner === packageName || row.owners?.includes(packageName))
  );
}

function terminates(statement) {
  if (!statement) return false;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isBlock(statement)) return statement.statements.some(terminates);
  return (
    ts.isIfStatement(statement) &&
    terminates(statement.thenStatement) &&
    terminates(statement.elseStatement)
  );
}

export function boundaryDeclarations(program, observer) {
  const { checker } = observer;
  const packages = new Map();
  const dependencySets = new Map();
  const callsBySource = new WeakMap();
  const decoderProofs = new WeakMap();

  function packageAt(filename) {
    let directory = dirname(filename);
    const searched = [];
    while (!packages.has(directory)) {
      searched.push(directory);
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const contract = readManifest(manifest);
        if (
          contract.name ||
          contract.dependencies ||
          contract.devDependencies
        ) {
          packages.set(directory, { manifest, ...contract });
          break;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        packages.set(directory, null);
        break;
      }
      directory = parent;
    }
    const owner = packages.get(directory);
    for (const searchedDirectory of searched) {
      packages.set(searchedDirectory, owner);
    }
    return owner;
  }

  function dependencies(source) {
    const owner = packageAt(source.fileName);
    if (!owner) {
      throw new Error(
        `Boundary model: missing package.json for ${source.fileName}`
      );
    }
    if (dependencySets.has(owner)) return dependencySets.get(owner);
    const manifests = new Map();
    for (const loaded of program.getSourceFiles()) {
      const dependency = packageAt(loaded.fileName);
      if (dependency?.name) manifests.set(dependency.name, dependency);
    }
    const names = new Set();
    const pending = [];
    let currentOwner = owner;
    while (currentOwner) {
      pending.push(currentOwner);
      const parentDirectory = dirname(dirname(currentOwner.manifest));
      if (parentDirectory === dirname(currentOwner.manifest)) break;
      const nextOwner = packageAt(parentDirectory);
      if (!nextOwner || nextOwner.manifest === currentOwner.manifest) break;
      currentOwner = nextOwner;
    }
    while (pending.length) {
      const manifest = pending.pop();
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      })) {
        if (names.has(name)) continue;
        names.add(name);
        if (manifests.has(name)) pending.push(manifests.get(name));
      }
    }
    dependencySets.set(owner, names);
    return names;
  }

  function origin(declaration, use) {
    const source = declaration.getSourceFile();
    if (program.isSourceFileDefaultLibrary(source)) return "platform";
    const owner = packageAt(source.fileName);
    if (owner?.name === "@types/node") return "platform";
    if (
      (owner && dependencies(use.getSourceFile()).has(owner.name)) ||
      program.isSourceFileFromExternalLibrary(source) ||
      source.fileName.includes("/node_modules/")
    ) {
      return "dependency";
    }
    return null;
  }

  function platformSource(declaration) {
    const source = declaration.getSourceFile();
    const modules = [];
    const names = [];
    let ancestor = declaration;
    while (ancestor && !ts.isSourceFile(ancestor)) {
      if (
        ts.isModuleDeclaration(ancestor) &&
        ts.isStringLiteral(ancestor.name)
      ) {
        modules.push(ancestor.name.text.replace(/^node:/u, ""));
      } else if (
        !(ancestor.flags & ts.NodeFlags.GlobalAugmentation) &&
        ancestor.name &&
        !ts.isParameter(ancestor) &&
        !ts.isTypeParameterDeclaration(ancestor)
      ) {
        names.unshift(ancestor.name.getText(source));
      }
      ancestor = ancestor.parent;
    }
    const baseSymbol = names.join(".");
    const parameterSymbol =
      ts.isParameter(declaration) && declaration.name
        ? [...names, declaration.name.getText(source)].join(".")
        : null;
    const ownerName = packageAt(source.fileName)?.name;
    return boundaryCases.roots.find((row) => {
      const symbolMatches =
        row.symbols?.includes(baseSymbol) ||
        Boolean(parameterSymbol && row.symbols?.includes(parameterSymbol));
      if (!symbolMatches) return false;
      if (row.libraries) {
        return (
          program.isSourceFileDefaultLibrary(source) &&
          row.libraries.includes(basename(source.fileName))
        );
      }
      return (
        rowMatchesOwner(row, ownerName) &&
        (!row.files || row.files.includes(basename(source.fileName))) &&
        (!row.modules || row.modules.some((module) => modules.includes(module)))
      );
    });
  }

  function exported(declaration) {
    const sourceSymbol = checker.getSymbolAtLocation(
      declaration.getSourceFile()
    );
    if (!sourceSymbol) return false;
    const binding = ts.isVariableDeclaration(declaration.parent)
      ? declaration.parent
      : declaration;
    return checker.getExportsOfModule(sourceSymbol).some((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      return target.declarations?.includes(binding);
    });
  }

  function callsInSource(source) {
    if (callsBySource.has(source)) return callsBySource.get(source);
    const collected = [];
    function visit(node) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        collected.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    callsBySource.set(source, collected);
    return collected;
  }

  function inspectionShape(type) {
    if (
      !(type.flags & ts.TypeFlags.Object) ||
      type.getCallSignatures().length ||
      type.getConstructSignatures().length
    ) {
      return false;
    }
    const members = [
      ...checker
        .getPropertiesOfType(type)
        .map((property) => checker.getTypeOfSymbol(property)),
      ...checker.getIndexInfosOfType(type).map((index) => index.type),
    ];
    return (
      members.length > 0 &&
      members.every((member) => Boolean(member.flags & ts.TypeFlags.Unknown))
    );
  }

  function inspectionAssertion(assertion) {
    return (
      inspectionShape(checker.getTypeFromTypeNode(assertion.type)) &&
      !broad(checker.getTypeAtLocation(assertion.expression))
    );
  }

  function passesAssertion(expression) {
    let current = expression;
    while (current && wrapperKinds.has(current.kind) && current.expression) {
      if (
        (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) &&
        !inspectionAssertion(current)
      ) {
        return true;
      }
      current = current.expression;
    }
    return false;
  }

  function assignedExpressions(declaration) {
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const scope = enclosingFunction(declaration) ?? declaration.getSourceFile();
    const expressions = [];
    function visit(node) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        checker.getSymbolAtLocation(node.left) === symbol
      ) {
        expressions.push(node.right);
      }
      ts.forEachChild(node, visit);
    }
    visit(scope);
    return expressions;
  }

  function deserializedArgument(call) {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    const row = declaration && platformSource(declaration);
    return row?.requiresProvenance ? call.arguments[row.argument] : null;
  }

  function carrierPath(expression, visited = new Set()) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) return null;
    visited.add(unwrapped);
    const asserted = passesAssertion(expression);
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const carrier = carrierPath(unwrapped.expression, visited);
      return (
        carrier && {
          ...carrier,
          path: [...carrier.path, unwrapped.name.text],
          asserted: carrier.asserted || asserted,
        }
      );
    }
    if (ts.isCallExpression(unwrapped)) {
      const opened = deserializedArgument(unwrapped);
      const carrier = opened && carrierPath(opened, visited);
      return (
        carrier && {
          ...carrier,
          path: [],
          deserialized: true,
          asserted: carrier.asserted || asserted,
        }
      );
    }
    if (!ts.isIdentifier(unwrapped)) return null;
    for (const declaration of checker.getSymbolAtLocation(unwrapped)
      ?.declarations ?? []) {
      if (ts.isParameter(declaration)) {
        return { parameter: declaration, path: [], asserted };
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const carrier = carrierPath(declaration.initializer, visited);
        return (
          carrier && { ...carrier, asserted: carrier.asserted || asserted }
        );
      }
    }
    return null;
  }

  function deserializesParameter(declaration, parameter) {
    if (!declaration.body) return false;
    let found = false;
    function visit(node) {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const opened = deserializedArgument(node);
        const carrier = opened && carrierPath(opened);
        if (carrier?.parameter === parameter && !carrier.deserialized) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(declaration.body);
    return found;
  }

  function signatureForm(signature) {
    if (!signature) return null;
    const predicate = checker.getTypePredicateOfSignature(signature);
    const output = checker.getAwaitedType(
      checker.getReturnTypeOfSignature(signature)
    );
    const declared =
      signature.declaration &&
      checker.getSignatureFromDeclaration(signature.declaration);
    if (!declared) return null;
    const broadParameter = declared.parameters.findIndex((symbol) =>
      broad(checker.getTypeOfSymbol(symbol))
    );
    const deserializedParameter =
      broadParameter >= 0
        ? -1
        : declared.parameters.findIndex(
            (symbol) =>
              Boolean(
                checker.getTypeOfSymbol(symbol).flags & ts.TypeFlags.String
              ) &&
              symbol.valueDeclaration &&
              ts.isParameter(symbol.valueDeclaration) &&
              deserializesParameter(
                signature.declaration,
                symbol.valueDeclaration
              )
          );
    const parameter = Math.max(broadParameter, deserializedParameter);
    if (excluded({ unresolvedReturn: !output })) return null;
    const carrier = carrierContract(signature.declaration, output);
    const predicateForm =
      predicate &&
      (predicate.kind === ts.TypePredicateKind.AssertsIdentifier ||
      predicate.kind === ts.TypePredicateKind.AssertsThis
        ? "asserts"
        : "is");
    for (const form of boundaryCases.decoders) {
      if (form.predicate && form.predicate === predicateForm) {
        const parameterIndex = predicate.parameterIndex;
        return {
          kind: form.output,
          form: form.kind,
          parameter: parameterIndex,
          output: predicate.type,
        };
      }
      if (form.input && parameter >= 0 && typed(output)) {
        if (form.output === "carrier" && carrier) {
          return { kind: form.kind, parameter, output, carrier };
        }
        if (form.output === "typed" && !carrier) {
          return {
            kind: form.kind,
            parameter,
            output,
            deserializes: parameter === deserializedParameter,
          };
        }
      }
    }
    return null;
  }

  function literalConstant(type) {
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return type.intrinsicName === "true";
    }
    return type.isLiteral() ? type.value : undefined;
  }

  function carrierContract(declaration, output) {
    if (!output.isUnion()) return null;
    const ownerName = packageAt(declaration.getSourceFile().fileName)?.name;
    const carrierForm = boundaryCases.decoders.find(
      (form) => form.output === "carrier"
    );
    for (const row of carrierForm.carriers) {
      if (!rowMatchesOwner(row, ownerName)) continue;
      const success = output.types.find((variant) => {
        const discriminant = checker.getPropertyOfType(
          variant,
          row.discriminant
        );
        const discriminantType =
          discriminant && checker.getTypeOfSymbol(discriminant);
        return Boolean(
          discriminantType &&
          literalConstant(discriminantType) === row.success &&
          checker.getPropertyOfType(variant, row.payload)
        );
      });
      if (success) {
        return { ...row, successVariant: success };
      }
    }
    return null;
  }

  function narrowedToSuccess(type, carrier) {
    const nonNull = type.getNonNullableType();
    const variants = nonNull.isUnion() ? nonNull.types : [nonNull];
    return variants.every((variant) => {
      const discriminant = checker.getPropertyOfType(
        variant,
        carrier.discriminant
      );
      const discriminantType =
        discriminant && checker.getTypeOfSymbol(discriminant);
      return Boolean(
        discriminantType &&
        literalConstant(discriminantType) === carrier.success
      );
    });
  }

  function subjectReference(expression, parameter) {
    const carrier = carrierPath(expression);
    return Boolean(
      carrier && carrier.parameter === parameter && !carrier.asserted
    );
  }

  function derivesFromSubject(expression, parameter, visited = new Set()) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped) || passesAssertion(expression)) {
      return false;
    }
    visited.add(unwrapped);
    if (
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped)
    ) {
      return derivesFromSubject(unwrapped.expression, parameter, visited);
    }
    if (ts.isCallExpression(unwrapped)) {
      const opened = deserializedArgument(unwrapped);
      if (opened) return derivesFromSubject(opened, parameter, visited);
      const evidence = decode(unwrapped);
      if (evidence) {
        return derivesFromSubject(evidence.input, parameter, visited);
      }
      const signature = checker.getResolvedSignature(unwrapped);
      const declaration = signature?.declaration;
      const returned = signature && checker.getReturnTypeOfSignature(signature);
      return Boolean(
        declaration &&
        origin(declaration, unwrapped) === null &&
        broad(checker.getAwaitedType(returned) ?? returned) &&
        unwrapped.arguments.some((argument) =>
          derivesFromSubject(argument, parameter, visited)
        )
      );
    }
    if (!ts.isIdentifier(unwrapped)) return false;
    return (checker.getSymbolAtLocation(unwrapped)?.declarations ?? []).some(
      (declaration) => {
        if (declaration === parameter) return true;
        if (!ts.isVariableDeclaration(declaration)) return false;
        const sources = declaration.initializer
          ? [declaration.initializer]
          : assignedExpressions(declaration);
        return (
          sources.length > 0 &&
          sources.every((source) =>
            derivesFromSubject(source, parameter, new Set(visited))
          )
        );
      }
    );
  }

  function annotatedBinding(expression) {
    if (!ts.isIdentifier(expression)) return null;
    for (const declaration of checker.getSymbolAtLocation(expression)
      ?.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.type &&
        declaration.initializer
      ) {
        return declaration;
      }
    }
    return null;
  }

  function unprovedNarrowing(expression) {
    let subject = unwrapExpression(expression);
    while (
      subject &&
      (ts.isPropertyAccessExpression(subject) ||
        ts.isElementAccessExpression(subject))
    ) {
      subject = unwrapExpression(subject.expression);
    }
    if (!subject || !ts.isIdentifier(subject)) return false;
    const owner = enclosingFunction(subject);
    const symbol = checker.getSymbolAtLocation(subject);
    if (!owner?.body || !symbol) return false;
    function visit(node) {
      if (ts.isFunctionLike(node) || node.pos >= subject.pos) return false;
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const predicate =
          signature && checker.getTypePredicateOfSignature(signature);
        const narrowed = predicate && node.arguments[predicate.parameterIndex];
        if (
          narrowed &&
          checker.getSymbolAtLocation(narrowed) === symbol &&
          !decode(node)
        ) {
          return true;
        }
      }
      return ts.forEachChild(node, visit);
    }
    return Boolean(visit(owner.body));
  }

  function failureLiteral(expression) {
    const unwrapped = unwrapExpression(expression);
    return Boolean(
      unwrapped &&
      (unwrapped.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
        ts.isReturnStatement(unwrapped))
    );
  }

  function validatedExpression(expression, parameter, visited = new Set()) {
    if (!expression || visited.has(expression)) return false;
    visited.add(expression);
    if (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return false;
    }
    if (wrapperKinds.has(expression.kind)) {
      return Boolean(
        expression.expression &&
        validatedExpression(expression.expression, parameter, visited)
      );
    }
    if (ts.isCallExpression(expression)) {
      const evidence = decode(expression);
      return Boolean(evidence && subjectReference(evidence.input, parameter));
    }
    const annotated = annotatedBinding(expression);
    if (annotated) {
      return validatedExpression(annotated.initializer, parameter, visited);
    }
    const carrier = carrierPath(expression);
    if (carrier?.parameter === parameter) {
      return !carrier.asserted && typed(checker.getTypeAtLocation(expression));
    }
    if (
      derivesFromSubject(expression, parameter) &&
      typed(checker.getTypeAtLocation(expression)) &&
      !unprovedNarrowing(expression)
    ) {
      return true;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const fields = expression.properties.filter(ts.isPropertyAssignment);
      return (
        fields.length === expression.properties.length &&
        fields.some((field) =>
          validatedExpression(field.initializer, parameter, new Set(visited))
        ) &&
        fields.every(
          (field) =>
            validatedExpression(
              field.initializer,
              parameter,
              new Set(visited)
            ) || ts.isLiteralExpression(field.initializer)
        )
      );
    }
    if (ts.isConditionalExpression(expression)) {
      const branches = [expression.whenTrue, expression.whenFalse];
      return (
        branches.some((branch) =>
          validatedExpression(branch, parameter, new Set(visited))
        ) &&
        branches.every(
          (branch) =>
            validatedExpression(branch, parameter, new Set(visited)) ||
            failureLiteral(branch)
        )
      );
    }
    if (!ts.isIdentifier(expression)) return false;
    return (checker.getSymbolAtLocation(expression)?.declarations ?? []).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        validatedExpression(declaration.initializer, parameter, visited)
    );
  }

  function predicateChecks(expression, parameter, checks = new Map()) {
    if (ts.isParenthesizedExpression(expression)) {
      return predicateChecks(expression.expression, parameter, checks);
    }
    if (!ts.isBinaryExpression(expression)) return checks;
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      predicateChecks(expression.left, parameter, checks);
      predicateChecks(expression.right, parameter, checks);
      return checks;
    }
    if (
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      return checks;
    }
    if (
      ts.isTypeOfExpression(expression.left) &&
      ts.isStringLiteral(expression.right)
    ) {
      const carrier = carrierPath(expression.left.expression);
      if (carrier?.parameter === parameter) {
        checks.set(carrier.path.join("."), {
          kind: "typeof",
          guard: expression.right.text,
        });
      }
      return checks;
    }
    const carrier = carrierPath(expression.left);
    if (
      carrier?.parameter === parameter &&
      (ts.isStringLiteral(expression.right) ||
        ts.isNumericLiteral(expression.right) ||
        expression.right.kind === ts.SyntaxKind.TrueKeyword ||
        expression.right.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      const contract = checker.getTypeAtLocation(expression.right);
      checks.set(carrier.path.join("."), { kind: "literal", contract });
    }
    return checks;
  }

  function predicateReturn(expression, parameter, output) {
    if (!output) return false;
    if (ts.isCallExpression(expression)) {
      const evidence = decode(expression);
      return Boolean(
        evidence?.kind === "predicate" &&
        subjectReference(evidence.input, parameter) &&
        evidence.output &&
        checker.isTypeAssignableTo(evidence.output, output)
      );
    }
    const checks = predicateChecks(expression, parameter);
    const properties = checker.getPropertiesOfType(output);
    const subjects = properties.length
      ? properties.map((property) => [
          property.name,
          checker.getTypeOfSymbol(property),
        ])
      : [["", output]];
    return subjects.every(([name, contract]) => {
      const check = checks.get(name);
      if (!check) return false;
      if (check.kind === "literal") {
        return checker.isTypeAssignableTo(check.contract, contract);
      }
      return boundaryCases.primitiveGuards.some(
        (guard) =>
          check.guard === guard.typeof &&
          Boolean(contract.flags & ts.TypeFlags[guard.flag])
      );
    });
  }

  function assertionBody(declaration, parameter, output) {
    if (!ts.isBlock(declaration.body)) return false;
    const guard = declaration.body.statements.at(-1);
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) return false;
    const condition = guard.expression;
    const failure = ts.isBlock(guard.thenStatement)
      ? guard.thenStatement.statements.at(-1)
      : guard.thenStatement;
    return Boolean(
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken &&
      failure &&
      ts.isThrowStatement(failure) &&
      predicateReturn(condition.operand, parameter, output)
    );
  }

  function blockedByUnprovedNarrowing(
    expression,
    parameter,
    visited = new Set()
  ) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || visited.has(unwrapped)) {
      return false;
    }
    visited.add(unwrapped);
    if (
      derivesFromSubject(unwrapped, parameter) &&
      typed(checker.getTypeAtLocation(unwrapped)) &&
      unprovedNarrowing(unwrapped)
    ) {
      return true;
    }
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    return (checker.getSymbolAtLocation(unwrapped)?.declarations ?? []).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        blockedByUnprovedNarrowing(declaration.initializer, parameter, visited)
    );
  }

  function decoderBranch(declaration, evidence, returns, proven) {
    const { decoderBranches } = boundaryObservations;
    if (evidence.form === "assertion" && !returns.length) {
      return decoderBranches.assertionBody;
    }
    if (evidence.kind === "predicate") {
      return decoderBranches.predicateReturn;
    }
    if (!declaration.body || !returns.length) {
      return decoderBranches.derivationRefused;
    }
    if (proven) {
      return returns.some((expression) => failureLiteral(expression))
        ? decoderBranches.failureLiteral
        : decoderBranches.validatedReturn;
    }
    if (
      returns.some((expression) =>
        blockedByUnprovedNarrowing(
          expression,
          declaration.parameters[evidence.parameter]
        )
      )
    ) {
      return decoderBranches.unprovedNarrowing;
    }
    return returns.every((expression) => failureLiteral(expression))
      ? decoderBranches.failureLiteral
      : decoderBranches.derivationRefused;
  }

  function implementationDecode(declaration, evidence) {
    if (decoderProofs.has(declaration)) {
      return decoderProofs.get(declaration);
    }
    decoderProofs.set(declaration, false);
    if (!declaration.body) {
      if (observer.enabled) {
        observer.decoderProof({
          declaration,
          evidence,
          proved: false,
          branch: boundaryObservations.decoderBranches.derivationRefused,
        });
      }
      return false;
    }
    const parameter = declaration.parameters[evidence.parameter];
    const returns = callbackReturns(declaration);
    const provedReturn = (expression) =>
      evidence.kind === "predicate"
        ? predicateReturn(expression, parameter, evidence.output)
        : validatedExpression(expression, parameter);
    const proven =
      evidence.form === "assertion" && !returns.length
        ? assertionBody(declaration, parameter, evidence.output)
        : (!ts.isBlock(declaration.body) || terminates(declaration.body)) &&
          returns.some(provedReturn) &&
          returns.every(
            (expression) =>
              provedReturn(expression) ||
              (evidence.kind !== "predicate" && failureLiteral(expression))
          );
    decoderProofs.set(declaration, proven);
    if (observer.enabled) {
      observer.decoderProof({
        declaration,
        evidence,
        proved: proven,
        branch: decoderBranch(declaration, evidence, returns, proven),
      });
    }
    return proven;
  }

  function signatureDecode(signature, use) {
    const evidence = signatureForm(signature);
    if (!evidence || !signature.declaration) {
      return null;
    }
    const declaration = signature.declaration;
    const source = declaration.getSourceFile();
    const ownerName = packageAt(source.fileName)?.name;
    const platform =
      program.isSourceFileDefaultLibrary(source) ||
      boundaryCases.roots.some(
        (row) => row.platform && rowMatchesOwner(row, ownerName)
      );
    const platformProjection = platform && evidence.kind !== "predicate";
    const unprovedDecoder =
      !platform &&
      origin(declaration, use) !== "dependency" &&
      !implementationDecode(declaration, evidence);
    if (excluded({ platformProjection, unprovedDecoder })) {
      return null;
    }
    return evidence;
  }

  function decode(call) {
    if (!ts.isCallExpression(call)) return null;
    const signature = checker.getResolvedSignature(call);
    const evidence = signatureDecode(signature, call);
    if (!evidence || !call.arguments[evidence.parameter]) return null;
    return { ...evidence, call, input: call.arguments[evidence.parameter] };
  }

  return {
    packageAt,
    narrowedToSuccess,
    passesAssertion,
    origin,
    platformSource,
    exported,
    callsInSource,
    carrierPath,
    signatureForm,
    signatureDecode,
    decode,
    unprovedNarrowing,
  };
}
