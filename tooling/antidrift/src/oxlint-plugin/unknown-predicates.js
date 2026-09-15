import { dirname } from "node:path";
import ts from "typescript";

import { findVariable } from "../semantic-adapters/async-control-flow.mjs";

function localPredicate(node) {
  const signature =
    node?.type === "VariableDeclarator"
      ? (node.id.typeAnnotation?.typeAnnotation ?? node.init)
      : node;
  const predicate = signature?.returnType?.typeAnnotation;
  if (predicate?.type !== "TSTypePredicate" || !predicate.typeAnnotation) {
    return null;
  }
  const index = signature.params.findIndex(
    (parameter) => parameter.name === predicate.parameterName.name,
  );
  return index < 0 ? null : { index, asserts: predicate.asserts };
}

function sourcePredicate(node) {
  const signature = ts.isVariableDeclaration(node)
    ? (node.type ?? node.initializer)
    : node;
  const predicate = signature?.type;
  if (
    !predicate ||
    !ts.isTypePredicateNode(predicate) ||
    !predicate.type ||
    !ts.isIdentifier(predicate.parameterName)
  ) {
    return null;
  }
  const index = signature.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === predicate.parameterName.text,
  );
  return index < 0
    ? null
    : { index, asserts: Boolean(predicate.assertsModifier) };
}

function modulePredicates(filename, specifier, cache) {
  const configPath = ts.findConfigFile(dirname(filename), ts.sys.fileExists);
  const config = configPath && ts.readConfigFile(configPath, ts.sys.readFile);
  const options =
    config && !config.error
      ? ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          dirname(configPath),
        ).options
      : { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const target = ts.resolveModuleName(specifier, filename, options, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (!target) return new Map();
  if (cache.has(target)) return cache.get(target);
  const predicates = new Map();
  cache.set(target, predicates);
  const text = ts.sys.readFile(target);
  if (text === undefined) return predicates;
  const source = ts.createSourceFile(
    target,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    const declarations = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : [statement];
    for (const declaration of declarations) {
      const predicate = sourcePredicate(declaration);
      if (!predicate) continue;
      const isDefault = statement.modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      predicates.set(isDefault ? "default" : declaration.name?.text, predicate);
    }
  }
  return predicates;
}

export function predicateCall(call, variable, context, cache) {
  if (
    call?.type !== "CallExpression" ||
    call.optional ||
    call.callee.type !== "Identifier"
  ) {
    return null;
  }
  const callee = findVariable(context.sourceCode, call.callee);
  if (
    !callee ||
    callee.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  ) {
    return null;
  }
  for (const definition of callee.defs) {
    let predicate;
    if (definition.type === "ImportBinding") {
      const specifier = definition.node;
      if (
        specifier.importKind === "type" ||
        definition.parent.importKind === "type"
      ) {
        continue;
      }
      const name =
        specifier.type === "ImportDefaultSpecifier"
          ? "default"
          : specifier.imported?.name;
      predicate = modulePredicates(
        context.filename,
        definition.parent.source.value,
        cache,
      ).get(name);
    } else {
      predicate = localPredicate(definition.node);
    }
    if (!predicate) continue;
    const argument = call.arguments[predicate.index];
    if (
      argument?.type === "Identifier" &&
      findVariable(context.sourceCode, argument) === variable
    ) {
      return predicate;
    }
  }
  return null;
}

export function isDecoderArgument(identifier) {
  const call = identifier.parent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(identifier)) {
    return false;
  }
  const callee = call.callee;
  let name = null;
  if (callee.type === "Identifier") name = callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    name = callee.property.name;
  }
  return (
    typeof name === "string" &&
    /^(?:decode|parse|validate|safeParse)(?:$|[A-Z_])/u.test(name)
  );
}
