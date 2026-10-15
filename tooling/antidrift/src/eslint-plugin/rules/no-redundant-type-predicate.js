import ts from "typescript";

import {
  functionParameterByName,
  typePredicateParts,
} from "../../semantic-adapters/broad-input.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/ts-rule-kernel.mjs";

// TypeScript 5.5 infers `x is T` for a function without a return annotation
// whose single returned expression narrows `x` to T on true and to never
// within T on false.
function infersTypePredicates() {
  const [major, minor] = ts.versionMajorMinor.split(".").map(Number);
  return major > 5 || (major === 5 && minor >= 5);
}

const TYPEOF_TYPES = new Map([
  ["string", { flags: ts.TypeFlags.StringLike, type: "getStringType" }],
  ["number", { flags: ts.TypeFlags.NumberLike, type: "getNumberType" }],
  ["bigint", { flags: ts.TypeFlags.BigIntLike, type: "getBigIntType" }],
  ["boolean", { flags: ts.TypeFlags.BooleanLike, type: "getBooleanType" }],
  ["symbol", { flags: ts.TypeFlags.ESSymbolLike, type: "getESSymbolType" }],
  ["undefined", { flags: ts.TypeFlags.Undefined, type: "getUndefinedType" }],
]);

const BROAD_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

function isCallbackArgument(callback) {
  const parent = callback.parent;
  return (
    (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
    parent.arguments.includes(callback)
  );
}

function singleReturnedExpression(callback) {
  if (callback.body.type !== "BlockStatement") return callback.body;
  const [statement, ...rest] = callback.body.body;
  return rest.length === 0 && statement?.type === "ReturnStatement"
    ? statement.argument
    : null;
}

function isParam(node, paramName) {
  return node?.type === "Identifier" && node.name === paramName;
}

function isNullLiteral(node) {
  return node?.type === "Literal" && node.value === null && !node.regex;
}

function isUndefinedIdentifier(node) {
  return node?.type === "Identifier" && node.name === "undefined";
}

function isPrimitiveLiteral(node) {
  return (
    node?.type === "Literal" &&
    !node.regex &&
    node.bigint === undefined &&
    ["string", "number", "boolean"].includes(typeof node.value)
  );
}

function memberOfParam(node, paramName) {
  const member = node?.type === "ChainExpression" ? node.expression : node;
  if (
    member?.type !== "MemberExpression" ||
    member.computed ||
    member.property.type !== "Identifier" ||
    !isParam(member.object, paramName)
  ) {
    return null;
  }
  return { property: member.property.name, optional: member.optional };
}

function orderedSides(node) {
  return [
    [node.left, node.right],
    [node.right, node.left],
  ];
}

// The single native check in the body: `x instanceof C`,
// `typeof x === "string"`, `x.kind === "a"` / `x?.kind === "a"`, or
// `x !== null` / `x !== undefined` / `x != null`.
function nativeCheck(expression, paramName) {
  if (expression?.type !== "BinaryExpression") return null;
  if (expression.operator === "instanceof") {
    return isParam(expression.left, paramName)
      ? { kind: "instanceof", constructor: expression.right }
      : null;
  }
  if (expression.operator === "===" || expression.operator === "==") {
    for (const [side, other] of orderedSides(expression)) {
      if (
        side.type === "UnaryExpression" &&
        side.operator === "typeof" &&
        isParam(side.argument, paramName) &&
        other.type === "Literal" &&
        TYPEOF_TYPES.has(other.value)
      ) {
        return { kind: "typeof", ...TYPEOF_TYPES.get(other.value) };
      }
      const member = memberOfParam(side, paramName);
      if (member && isPrimitiveLiteral(other)) {
        return { kind: "discriminant", ...member, literal: other };
      }
    }
    return null;
  }
  if (expression.operator === "!==" || expression.operator === "!=") {
    for (const [side, other] of orderedSides(expression)) {
      if (!isParam(side, paramName)) continue;
      if (!isNullLiteral(other) && !isUndefinedIdentifier(other)) continue;
      return {
        kind: "nonNullish",
        flags: excludedNullishFlags(expression, other),
      };
    }
  }
  return null;
}

// `x != null` excludes null and undefined; `x !== null` only null;
// `x !== undefined` only undefined.
function excludedNullishFlags(expression, other) {
  if (expression.operator === "!=") {
    return ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  }
  if (isNullLiteral(other)) return ts.TypeFlags.Null;
  return ts.TypeFlags.Undefined | ts.TypeFlags.Void;
}

function constituents(type) {
  return type.isUnion() ? type.types : [type];
}

function isUnitType(type) {
  return (
    type.isLiteral() ||
    (type.flags &
      (ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.EnumLiteral |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)) !==
      0
  );
}

// TypeScript narrows `x instanceof C` to the type of `C.prototype`. Generic
// classes are skipped: their prototype type is instantiated with `any`.
function instanceTypeOf(checker, constructorType) {
  const signatures = constructorType.getConstructSignatures();
  if (signatures.some((signature) => signature.typeParameters?.length)) {
    return null;
  }
  const prototype = constructorType.getProperty("prototype");
  const instance = prototype && checker.getTypeOfSymbol(prototype);
  return instance && (instance.flags & BROAD_FLAGS) === 0 ? instance : null;
}

// The type TypeScript narrows the parameter to when the check is true, as a
// list of union constituents, or null when TypeScript would not infer a
// predicate (no narrowing, or the false branch does not exclude all of it).
function inferredConstituents(checker, services, check, paramType) {
  const parts = constituents(paramType);
  const broad = (paramType.flags & BROAD_FLAGS) !== 0;
  let kept;
  if (check.kind === "instanceof") {
    const tsConstructor = services.esTreeNodeToTSNodeMap.get(check.constructor);
    const instance =
      tsConstructor &&
      instanceTypeOf(checker, checker.getTypeAtLocation(tsConstructor));
    if (!instance) return null;
    if (broad) return [instance];
    kept = parts.filter((part) => checker.isTypeAssignableTo(part, instance));
  } else if (check.kind === "typeof") {
    if (broad) return [checker[check.type]()];
    kept = parts.filter((part) => (part.flags & check.flags) !== 0);
  } else if (check.kind === "nonNullish") {
    if (broad) return null;
    kept = parts.filter((part) => (part.flags & check.flags) === 0);
  } else {
    if (broad || !paramType.isUnion()) return null;
    const tsLiteral = services.esTreeNodeToTSNodeMap.get(check.literal);
    const literalType = tsLiteral && checker.getTypeAtLocation(tsLiteral);
    if (!literalType) return null;
    kept = [];
    for (const part of parts) {
      if (
        part.flags &
        (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
      ) {
        if (!check.optional) return null;
        continue;
      }
      const property = checker.getPropertyOfType(part, check.property);
      if (!property) return null;
      const propertyType = checker.getTypeOfSymbol(property);
      if (!constituents(propertyType).every(isUnitType)) return null;
      if (!checker.isTypeAssignableTo(literalType, propertyType)) continue;
      // A member whose tag could also be another value survives the false
      // branch, so TypeScript would not infer the predicate.
      if (propertyType.isUnion()) return null;
      kept.push(part);
    }
  }
  return kept.length > 0 && kept.length < parts.length ? kept : null;
}

function sameType(checker, asserted, inferred) {
  if (asserted.flags & BROAD_FLAGS) return false;
  return (
    inferred.every((part) => checker.isTypeAssignableTo(part, asserted)) &&
    constituents(asserted).every((part) =>
      inferred.some((candidate) => checker.isTypeAssignableTo(part, candidate))
    )
  );
}

// Import specifiers whose every reference sits inside the deleted annotation;
// deleting the annotation would otherwise leave them unused.
function orphanedImportRemovals(sourceCode, fixer, annotation) {
  const [annotationStart, annotationEnd] = annotation.range;
  const fixes = [];
  for (const declaration of sourceCode.ast.body) {
    if (declaration.type !== "ImportDeclaration") continue;
    const orphaned = declaration.specifiers.filter((specifier) =>
      sourceCode
        .getDeclaredVariables(specifier)
        .every(
          (importedBinding) =>
            importedBinding.references.length > 0 &&
            importedBinding.references.every(
              ({ identifier }) =>
                identifier.range[0] >= annotationStart &&
                identifier.range[1] <= annotationEnd
            )
        )
    );
    if (orphaned.length === 0) continue;
    if (orphaned.length === declaration.specifiers.length) {
      fixes.push(fixer.remove(declaration));
      continue;
    }
    const named = declaration.specifiers.filter(
      (specifier) => specifier.type === "ImportSpecifier"
    );
    const namedOrphaned =
      named.length > 0 && named.every((member) => orphaned.includes(member));
    if (namedOrphaned) {
      // `import X, { Y }` with every named specifier orphaned: drop `, { Y }`.
      const open = sourceCode.getTokenBefore(named[0]);
      const close = sourceCode.getTokenAfter(named.at(-1), {
        filter: (token) => token.value === "}",
      });
      fixes.push(
        fixer.removeRange([
          sourceCode.getTokenBefore(open).range[0],
          close.range[1],
        ])
      );
    }
    for (const specifier of orphaned) {
      if (namedOrphaned && specifier.type === "ImportSpecifier") continue;
      const index = declaration.specifiers.indexOf(specifier);
      const keptAfter = declaration.specifiers
        .slice(index + 1)
        .some((member) => !orphaned.includes(member));
      if (keptAfter) {
        const comma = sourceCode.getTokenAfter(specifier);
        fixes.push(
          fixer.removeRange([
            specifier.range[0],
            sourceCode.getTokenAfter(comma).range[0],
          ])
        );
      } else {
        const comma = sourceCode.getTokenBefore(specifier);
        fixes.push(fixer.removeRange([comma.range[0], specifier.range[1]]));
      }
    }
  }
  return fixes;
}

export function ruleNoRedundantTypePredicate() {
  return defineTypeScriptRule({
    ruleName: "no-redundant-type-predicate",
    skipGenerated: false,
    meta: {
      type: "suggestion",
      fixable: "code",
      docs: {
        description:
          "Disallow explicit `x is T` callback annotations that TypeScript 5.5+ infers from a single native check.",
      },
      schema: [],
    },
    visitors({ context, checker, services }) {
      if (!infersTypePredicates()) return {};
      function check(callback) {
        if (callback.async || callback.generator) return;
        if (!isCallbackArgument(callback)) return;
        const parts = typePredicateParts(callback);
        if (!parts || callback.returnType.typeAnnotation.asserts) return;
        const predicateParameter = functionParameterByName(
          callback,
          parts.paramName
        );
        if (predicateParameter?.type !== "Identifier") return;
        const native = nativeCheck(
          singleReturnedExpression(callback),
          parts.paramName
        );
        if (!native) return;
        const tsParam = services.esTreeNodeToTSNodeMap.get(predicateParameter);
        const tsTarget = services.esTreeNodeToTSNodeMap.get(
          parts.targetTypeNode
        );
        if (!tsParam || !tsTarget) return;
        const paramType = checker.getTypeAtLocation(tsParam);
        if (
          paramType.flags & ts.TypeFlags.TypeParameter ||
          paramType.intrinsicName === "error"
        ) {
          return;
        }
        const inferred = inferredConstituents(
          checker,
          services,
          native,
          paramType
        );
        if (
          !inferred ||
          !sameType(checker, checker.getTypeFromTypeNode(tsTarget), inferred)
        ) {
          return;
        }
        context.report({
          node: callback.returnType,
          message:
            "TypeScript infers this type predicate from the check. Delete the explicit `x is T` annotation so the assertion cannot drift from the check.",
          fix: (fixer) => [
            fixer.remove(callback.returnType),
            ...orphanedImportRemovals(
              context.sourceCode,
              fixer,
              callback.returnType
            ),
          ],
        });
      }
      return {
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  });
}
