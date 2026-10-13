import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { z } from "zod";

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

const models = new WeakMap();
const broadFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

function enclosingFunction(node) {
  let ancestor = node.parent;
  while (ancestor && !ts.isFunctionLike(ancestor)) ancestor = ancestor.parent;
  return ancestor;
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
  const packages = new Map();
  const writesBySource = new WeakMap();
  const dependencySets = new Map();

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
    const pending = [owner];
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
    if (owner && dependencies(use.getSourceFile()).has(owner.name)) {
      return "dependency";
    }
    return null;
  }

  function broad(type) {
    return Boolean(type && type.flags & broadFlags);
  }

  function declaredBroad(type) {
    const awaited = checker.getPromisedTypeOfPromise(type) ?? type;
    if (broad(awaited)) return true;
    if (!(awaited?.flags & ts.TypeFlags.TypeParameter)) return false;
    const defaultType = checker.getDefaultFromTypeParameter(awaited);
    return Boolean(defaultType?.flags & ts.TypeFlags.Any);
  }

  function typed(type) {
    return Boolean(
      type &&
      !(
        type.flags &
        (broadFlags |
          ts.TypeFlags.Void |
          ts.TypeFlags.Never |
          ts.TypeFlags.TypeParameter)
      )
    );
  }

  function signatureDecode(signature) {
    if (!signature) return null;
    const predicate = checker.getTypePredicateOfSignature(signature);
    if (predicate) {
      return {
        kind: "predicate",
        parameter: predicate.parameterIndex,
        output: predicate.type,
      };
    }
    const output = checker.getAwaitedType(
      checker.getReturnTypeOfSignature(signature)
    );
    if (!typed(output)) return null;
    const parameter = signature.parameters.findIndex((symbol) =>
      broad(checker.getTypeOfSymbol(symbol))
    );
    if (parameter < 0) return null;
    const variants = output.isUnion() ? output.types : [];
    const discriminated =
      variants.length > 1 &&
      checker.getPropertiesOfType(output).some((property) =>
        variants.every((variant) => {
          const member = checker.getPropertyOfType(variant, property.name);
          const memberType = member && checker.getTypeOfSymbol(member);
          return (
            memberType &&
            Boolean(
              memberType.flags &
              (ts.TypeFlags.StringLiteral |
                ts.TypeFlags.BooleanLiteral |
                ts.TypeFlags.NumberLiteral)
            )
          );
        })
      );
    return { kind: discriminated ? "result" : "value", parameter, output };
  }

  function decode(call) {
    if (!ts.isCallExpression(call)) return null;
    const signature = checker.getResolvedSignature(call);
    const evidence = signatureDecode(signature);
    if (!evidence || !call.arguments[evidence.parameter]) return null;
    return { ...evidence, call, input: call.arguments[evidence.parameter] };
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

  function parameterRoot(parameter, use) {
    const signature = checker.getSignatureFromDeclaration(parameter.parent);
    const decoder = signatureDecode(signature);
    if (
      decoder?.parameter === parameter.parent.parameters.indexOf(parameter) &&
      (parameter.parent.type || decoder.kind === "predicate")
    ) {
      return [];
    }
    if (
      parameter.type &&
      checker.getTypeFromTypeNode(parameter.type).flags &
        ts.TypeFlags.Unknown &&
      exported(parameter.parent)
    ) {
      return [{ kind: "contract", root: parameter, declaration: parameter }];
    }
    if (!ts.isExpression(parameter.parent)) return [];
    const contextual = checker.getContextualType(parameter.parent);
    const signatures = contextual?.getCallSignatures() ?? [];
    const index = parameter.parent.parameters.indexOf(parameter);
    for (const contextualSignature of signatures) {
      const subject = contextualSignature.parameters[index];
      for (const declaration of subject?.declarations ?? []) {
        const kind = origin(declaration, use);
        if (kind && declaredBroad(checker.getTypeOfSymbol(subject))) {
          return [{ kind, root: parameter, declaration }];
        }
      }
    }
    return [];
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

  function bindingRoots(declaration, use, visited) {
    if (ts.isParameter(declaration)) return parameterRoot(declaration, use);
    if (ts.isBindingElement(declaration)) {
      let binding = declaration.parent;
      while (!ts.isVariableDeclaration(binding) && !ts.isParameter(binding)) {
        binding = binding.parent;
      }
      return bindingRoots(binding, use, visited);
    }
    if (!ts.isVariableDeclaration(declaration)) return [];
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const assignments = (writes(use.getSourceFile()).get(symbol) ?? []).filter(
      (assignment) =>
        assignment.end < use.pos &&
        enclosingFunction(assignment) === enclosingFunction(use)
    );
    const last = assignments.findLast((assignment) =>
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
    return expressions.flatMap((expression) =>
      trace(expression, { use, visited: new Set(visited) })
    );
  }

  function callRoots(call, use, visited) {
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!declaration) return [];
    const evidence = decode(call);
    if (evidence?.kind === "value") return [];
    if (evidence?.kind === "result") {
      const roots = trace(evidence.input, { use, visited });
      return roots.map((root) => ({ ...root, pending: evidence }));
    }
    const declared = checker.getSignatureFromDeclaration(declaration);
    const output = declared && checker.getReturnTypeOfSignature(declared);
    const kind = origin(declaration, use);
    const outputSubject =
      output && (checker.getPromisedTypeOfPromise(output) ?? output);
    const tiedInput =
      Boolean(outputSubject?.flags & ts.TypeFlags.TypeParameter) &&
      declared.parameters.some(
        (parameter) => checker.getTypeOfSymbol(parameter) === outputSubject
      );
    if (kind && output && declaredBroad(output) && !tiedInput) {
      return [{ kind, root: call, declaration }];
    }
    return [];
  }

  function memberRoots(expression, flow) {
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression
    );
    for (const declaration of symbol?.declarations ?? []) {
      const kind = origin(declaration, flow.use);
      if (
        kind &&
        declaredBroad(checker.getTypeOfSymbolAtLocation(symbol, declaration)) &&
        broad(checker.getTypeAtLocation(expression))
      ) {
        return [{ kind, root: expression, declaration }];
      }
    }
    const receiver = checker.getTypeAtLocation(expression.expression);
    for (const index of checker.getIndexInfosOfType(receiver)) {
      if (!index.declaration || !(index.keyType.flags & ts.TypeFlags.String)) {
        continue;
      }
      const kind = origin(index.declaration, flow.use);
      const parts = index.type.isUnion() ? index.type.types : [index.type];
      if (
        kind === "platform" &&
        parts.some((part) => part.flags & ts.TypeFlags.Undefined)
      ) {
        return [{ kind, root: expression, declaration: index.declaration }];
      }
    }
    return trace(expression.expression, flow);
  }

  function trace(expression, flow = { use: expression, visited: new Set() }) {
    const { visited } = flow;
    if (visited.has(expression)) return [];
    visited.add(expression);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAwaitExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return trace(expression.expression, flow);
    }
    if (ts.isCallExpression(expression)) {
      return callRoots(expression, flow.use, visited);
    }
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      return memberRoots(expression, flow);
    }
    if (ts.isConditionalExpression(expression)) {
      return [expression.whenTrue, expression.whenFalse].flatMap((branch) =>
        trace(branch, { ...flow, visited: new Set(visited) })
      );
    }
    if (!ts.isIdentifier(expression)) return [];
    const declarations =
      checker.getSymbolAtLocation(expression)?.declarations ?? [];
    return declarations.flatMap((declaration) =>
      bindingRoots(declaration, expression, visited)
    );
  }

  function unchecked(expression, target) {
    if (!typed(target)) return [];
    const actual = checker.getTypeAtLocation(expression);
    const roots = trace(expression);
    if (!broad(actual) && checker.isTypeAssignableTo(actual, target)) {
      if (roots.some((root) => root.pending)) return [];
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        if (symbol && broad(checker.getTypeOfSymbol(symbol))) return [];
      }
      if (
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)
      ) {
        return [];
      }
    }
    return roots;
  }

  const model = { trace, decode, unchecked };
  models.set(program, model);
  return model;
}
