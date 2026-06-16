import { ESLintUtils } from "@typescript-eslint/utils";
import ts from "typescript";

import {
  createReactStateTracker,
  frameStatePayload,
  lifecycleProof,
  sourceShardProof,
} from "./react-state-graph.js";
import {
  emitSemanticFact,
  semanticFactSink,
} from "../policy/lib/semantic-facts.mjs";
import {
  asyncArrayCallbackClassification,
  findVariable,
  getDeclaredVariable,
  isDirectlyWrappedInPromiseCombinator,
  markAwaitedPendingMaps,
  queuePendingAsyncMap,
} from "../semantic-adapters/async-control-flow.mjs";
import {
  DEFAULT_AUTHZ_FUNCTIONS,
  createAuthBoundaryTracker,
} from "../semantic-adapters/auth-boundary.mjs";
import {
  checkedTargetProperties,
  countShapeProbesIn,
  functionParameterByName,
  hasBroadObjectEntriesValue,
  hasValidatorDelegation,
  isAppeasementContractCast,
  isBroadPredicateInputType,
  isPredicateObjectContract,
  objectEntriesCallbackProbe,
  requiredTypeProps,
  typePredicateParts,
} from "../semantic-adapters/broad-input.mjs";
import { isUnsafeJsonParseInput } from "../semantic-adapters/parse-input.mjs";
import {
  isAwaitedCallInitializer,
  isCallResultExpression,
  isThrowAssertionCallbackParse,
  isZodParseExpression,
  parsedCallResultMatchesSchemaOutput,
  recordParsedConst,
  zodParseCallParts,
} from "../semantic-adapters/schema-provenance.mjs";
import {
  isSqlDirectionTokenValue,
  isSqlIdentifierContext,
  isSqlIdentifierTokenValue,
  isSqlInterpolationContext,
  safeIdentifierMemberSpecs,
  templateStaticPartsAreSqlIdentifierSafe,
  valuesAreSqlDirections,
  valuesAreSqlIdentifiers,
} from "../semantic-adapters/sql.mjs";
import { hasNullablePositionalTuple } from "../semantic-adapters/tuple-shape.mjs";
import {
  MIN_PROPS,
  canonicalStatusLiteralOwner,
  collectAcceptedPackageCanonicalTypes,
  collectCanonicalTypes,
  collectDomainCanonicalTypes,
  collectGeneratedCanonicalTypes,
  isObjectType,
  resolvesToDomainCanonicalType,
  resolvesToGeneratedType,
  resolvesToInstalledType,
  typeProps,
} from "../semantic-adapters/type-owner.mjs";

const rawTailwindColorPattern =
  /\b(?:text|bg|border|ring)-(?:red|blue|green|yellow|gray|slate|zinc|neutral)-\d{2,3}\b/u;
const hoverTranslatePattern = /hover:-?translate-[xy]/u;
const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/joedeleeuw/antidrift/tree/main/tooling/antidrift#${name}`,
);
const reactEffectHooks = new Set(["useEffect", "useLayoutEffect"]);
const collectionMetadataMemberNames = new Set(["length", "size"]);
const exportedLocalNamesByProgram = new WeakMap();
const structuralDerivationUtilities = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Required",
]);

const memberNodeTypes = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "Property",
]);

function missingTypeServicesVisitors(context, ruleName) {
  return {
    Program(node) {
      context.report({
        node,
        message: `antidrift/${ruleName} requires TypeScript parser services. Use @joedeleeuw/antidrift createConfig(...) or configure @typescript-eslint/parser with projectService/project.`,
      });
    },
  };
}

function requireTypeServices(context) {
  const services = context.sourceCode?.parserServices ?? context.parserServices;
  if (services?.program && services.esTreeNodeToTSNodeMap) return services;
  return null;
}

function getFunctionName(node) {
  if (node.type === "FunctionDeclaration") return node.id?.name ?? "";
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node.id?.name ?? "";
  }
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  if (memberNodeTypes.has(node.type)) {
    const key = node.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") {
      return key.name;
    }
    if (key?.type === "Literal" && typeof key.value === "string") {
      return key.value;
    }
  }
  return "";
}

function declarationName(node) {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  if (
    (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
    node.id?.type === "Identifier"
  ) {
    return node.id.name;
  }
  return getFunctionName(node);
}

function programNode(node) {
  let cur = node;
  while (cur?.parent) cur = cur.parent;
  return cur?.type === "Program" ? cur : null;
}

function exportedLocalNames(program) {
  if (!program) return new Set();
  const cached = exportedLocalNamesByProgram.get(program);
  if (cached) return cached;
  const names = new Set();
  for (const statement of program?.body ?? []) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.type === "Identifier") {
        names.add(specifier.local.name);
      }
    }
  }
  exportedLocalNamesByProgram.set(program, names);
  return names;
}

function isExported(node) {
  if (
    node.parent?.type === "ExportNamedDeclaration" ||
    node.parent?.type === "ExportDefaultDeclaration"
  ) {
    return true;
  }
  const name = declarationName(node);
  return Boolean(name && exportedLocalNames(programNode(node)).has(name));
}

function getFunctionNode(node) {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node;
  }
  if (node.type === "VariableDeclarator") return node.init;
  // Class methods/fields and object members hold the function in `value`; ignore non-function fields.
  if (memberNodeTypes.has(node.type)) {
    const value = node.value;
    return value?.type === "FunctionExpression" ||
      value?.type === "ArrowFunctionExpression"
      ? value
      : null;
  }
  return null;
}

function enclosingClassExported(memberNode) {
  const classNode = memberNode.parent?.parent; // member → ClassBody → Class
  if (
    classNode?.type !== "ClassDeclaration" &&
    classNode?.type !== "ClassExpression"
  ) {
    return false;
  }
  if (
    classNode.parent?.type === "ExportNamedDeclaration" ||
    classNode.parent?.type === "ExportDefaultDeclaration"
  ) {
    return true;
  }
  // export const X = class { ... }
  return (
    classNode.parent?.type === "VariableDeclarator" &&
    classNode.parent.parent?.parent?.type === "ExportNamedDeclaration"
  );
}

function enclosingObjectExported(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  if (objectNode.parent?.type === "ExportDefaultDeclaration") return true;
  return (
    objectNode.parent?.type === "VariableDeclarator" &&
    objectNode.parent.parent?.parent?.type === "ExportNamedDeclaration"
  );
}

function enclosingReturnedObjectFromBoundary(memberNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== "ObjectExpression") return false;
  if (
    objectNode.parent?.type === "ArrowFunctionExpression" &&
    objectNode.parent.body === objectNode
  ) {
    const arrowParent = objectNode.parent.parent;
    if (arrowParent?.type === "VariableDeclarator") {
      return isBoundary(arrowParent);
    }
    return isBoundary(objectNode.parent);
  }
  if (objectNode.parent?.type !== "ReturnStatement") return false;
  let cur = objectNode.parent.parent;
  while (cur) {
    if (cur.type === "FunctionDeclaration") return isBoundary(cur);
    if (
      (cur.type === "FunctionExpression" ||
        cur.type === "ArrowFunctionExpression") &&
      cur.parent?.type === "VariableDeclarator"
    ) {
      return isBoundary(cur.parent);
    }
    if (memberNodeTypes.has(cur.type)) return isBoundary(cur);
    cur = cur.parent;
  }
  return false;
}

function functionBoundaryNode(fn) {
  if (fn?.type === "FunctionDeclaration") return fn;
  if (
    (fn?.type === "FunctionExpression" ||
      fn?.type === "ArrowFunctionExpression") &&
    fn.parent?.type === "VariableDeclarator"
  ) {
    return fn.parent;
  }
  if (fn && memberNodeTypes.has(fn.parent?.type)) return fn.parent;
  return fn;
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression"
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function objectExpressionExposesIdentifier(objectNode, name) {
  return (
    objectNode?.type === "ObjectExpression" &&
    objectNode.properties.some((property) => {
      if (property.type !== "Property") return false;
      if (
        property.value?.type === "Identifier" &&
        property.value.name === name
      ) {
        return true;
      }
      return (
        property.shorthand &&
        property.key?.type === "Identifier" &&
        property.key.name === name
      );
    })
  );
}

function returnedObjectExposesIdentifier(fn, name) {
  if (fn?.body?.type === "ObjectExpression") {
    return objectExpressionExposesIdentifier(fn.body, name);
  }
  if (fn?.body?.type !== "BlockStatement") return false;
  return fn.body.body.some(
    (statement) =>
      statement.type === "ReturnStatement" &&
      objectExpressionExposesIdentifier(
        unwrapExpression(statement.argument),
        name,
      ),
  );
}

function callableReturnedFromBoundaryFactory(node) {
  const name = node.id?.type === "Identifier" ? node.id.name : null;
  if (!name) return false;
  const fn = getFunctionNode(node);
  if (!fn) return false;
  const owner = enclosingFunction(node);
  if (!owner || !isBoundary(functionBoundaryNode(owner))) return false;
  return returnedObjectExposesIdentifier(owner, name);
}

// A definition is a "boundary" (public contract, exempt from inference-appeasement rules) when it is
// an exported function/const, or a public method of an exported class. Private/protected/# members,
// and any member of a non-exported class, are internal. Getters/setters/constructors are never
// appeasement helpers. Abstract and interface signatures are different node types and never visited.
function isBoundary(node) {
  if (!memberNodeTypes.has(node.type)) {
    if (isExported(node)) return true;
    if (
      (node.type === "VariableDeclarator" ||
        node.type === "FunctionDeclaration") &&
      callableReturnedFromBoundaryFactory(node)
    ) {
      return true;
    }
    return (
      node.type === "VariableDeclarator" &&
      node.parent?.parent?.type === "ExportNamedDeclaration"
    );
  }
  if (
    node.kind === "get" ||
    node.kind === "set" ||
    node.kind === "constructor"
  ) {
    return true;
  }
  if (node.type === "Property") {
    return (
      enclosingObjectExported(node) || enclosingReturnedObjectFromBoundary(node)
    );
  }
  if (
    node.key?.type === "PrivateIdentifier" ||
    node.accessibility === "private" ||
    node.accessibility === "protected"
  ) {
    return false;
  }
  return enclosingClassExported(node);
}

function hasExplicitReturnType(fn) {
  return Boolean(fn?.returnType);
}

function unwrapExpression(expression) {
  if (expression?.type === "ChainExpression") return expression.expression;
  if (expression?.type === "TSAsExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSNonNullExpression") {
    return unwrapExpression(expression.expression);
  }
  if (expression?.type === "TSSatisfiesExpression") {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isMemberExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return unwrapped?.type === "MemberExpression";
}

function isSingleReturnMemberExpression(fn) {
  if (!fn?.body) return false;
  if (isMemberExpression(fn.body)) return true;
  if (fn.body.type !== "BlockStatement") return false;
  const statements = fn.body.body;
  return (
    statements.length === 1 &&
    statements[0]?.type === "ReturnStatement" &&
    isMemberExpression(statements[0].argument)
  );
}

function returnedExpression(fn) {
  if (!fn?.body) return null;
  if (fn.body.type !== "BlockStatement") return unwrapExpression(fn.body);
  const statements = fn.body.body;
  if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") {
    return null;
  }
  return unwrapExpression(statements[0].argument);
}

function parameterName(param) {
  if (param?.type === "Identifier") return param.name;
  if (
    param?.type === "AssignmentPattern" &&
    param.left?.type === "Identifier"
  ) {
    return param.left.name;
  }
  if (param?.type === "RestElement" && param.argument?.type === "Identifier") {
    return param.argument.name;
  }
  return null;
}

function assignmentTarget(node) {
  return node?.type === "AssignmentPattern" ? node.left : node;
}

function bindingIdentifierName(node) {
  const target = assignmentTarget(node);
  return target?.type === "Identifier" ? target.name : null;
}

function nestedObjectPattern(node) {
  const target = assignmentTarget(node);
  return target?.type === "ObjectPattern" ? target : null;
}

function collectObjectPatternBindingNames(pattern, names) {
  for (const property of pattern.properties ?? []) {
    const name =
      property.type === "RestElement"
        ? bindingIdentifierName(property.argument)
        : bindingIdentifierName(property.value);
    if (name) names.add(name);
    const nested =
      property.type === "Property" ? nestedObjectPattern(property.value) : null;
    if (nested) collectObjectPatternBindingNames(nested, names);
  }
}

function destructuredParameterBindingNames(fn) {
  const names = new Set();
  for (const param of fn.params ?? []) {
    const pattern = nestedObjectPattern(param);
    if (pattern) collectObjectPatternBindingNames(pattern, names);
  }
  return names;
}

function returnedIdentifierName(fn) {
  const expression = returnedExpression(fn);
  return expression?.type === "Identifier" ? expression.name : null;
}

function memberExpressionRootName(expression) {
  let cur = unwrapExpression(expression);
  while (cur?.type === "MemberExpression") cur = unwrapExpression(cur.object);
  return cur?.type === "Identifier" ? cur.name : null;
}

function terminalMemberName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped?.type !== "MemberExpression" ||
    unwrapped.computed ||
    unwrapped.property?.type !== "Identifier"
  ) {
    return null;
  }
  return unwrapped.property.name;
}

function returnsMemberOfOwnParameter(fn) {
  const params = new Set(fn.params.map(parameterName).filter(Boolean));
  const expression = returnedExpression(fn);
  if (expression?.type !== "MemberExpression") return false;
  const terminalName = terminalMemberName(expression);
  if (terminalName && collectionMetadataMemberNames.has(terminalName)) {
    return false;
  }
  const rootName = memberExpressionRootName(expression);
  return Boolean(rootName && params.has(rootName));
}

function returnsDestructuredOwnParameterBinding(fn) {
  const name = returnedIdentifierName(fn);
  return Boolean(name && destructuredParameterBindingNames(fn).has(name));
}

function isTrivialSelectorWrapper(fn) {
  return (
    (isSingleReturnMemberExpression(fn) && returnsMemberOfOwnParameter(fn)) ||
    returnsDestructuredOwnParameterBinding(fn)
  );
}

function isReactComponentName(name) {
  return /^[A-Z]/u.test(name);
}

function isFunctionLike(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function functionNodeName(fn) {
  if (fn?.type === "FunctionDeclaration") return fn.id?.name ?? "";
  if (
    (fn?.type === "FunctionExpression" ||
      fn?.type === "ArrowFunctionExpression") &&
    fn.parent?.type === "VariableDeclarator" &&
    fn.parent.id?.type === "Identifier"
  ) {
    return fn.parent.id.name;
  }
  if (
    (fn?.type === "FunctionExpression" ||
      fn?.type === "ArrowFunctionExpression") &&
    fn.parent?.type === "Property"
  ) {
    const key = fn.parent.key;
    if (key?.type === "Identifier" || key?.type === "PrivateIdentifier") {
      return key.name;
    }
    if (key?.type === "Literal" && typeof key.value === "string") {
      return key.value;
    }
  }
  return "";
}

function functionForImplementationParameter(param) {
  const maybeFunction = param?.parent;
  return isFunctionLike(maybeFunction) && maybeFunction.body
    ? maybeFunction
    : null;
}

function isBoundaryObjectMethod(fn) {
  const property = fn?.parent;
  return (
    property?.type === "Property" &&
    property.value === fn &&
    (enclosingObjectExported(property) ||
      enclosingReturnedObjectFromBoundary(property))
  );
}

function isExportedLowercaseFunction(fn) {
  const owner = fn?.type === "FunctionDeclaration" ? fn : fn?.parent;
  const name = functionNodeName(fn);
  return Boolean(
    name && !isReactComponentName(name) && owner && isBoundary(owner),
  );
}

function inlineStructuralTypeAtBoundary(node) {
  const parent = node.parent;
  const param = parent?.parent;
  if (parent?.type !== "TSTypeAnnotation" || param?.type !== "Identifier") {
    return false;
  }

  const fn = functionForImplementationParameter(param);
  if (!fn) return false;

  const name = functionNodeName(fn);
  if (name && isReactComponentName(name)) return false;

  return isBoundaryObjectMethod(fn) || isExportedLowercaseFunction(fn);
}

function collectTemplateLiteralString(node, parts) {
  if (node.expressions.length === 0) {
    parts.push(
      node.quasis
        .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
        .join(""),
    );
  }
}

function collectConditionalStringParts(node, parts) {
  staticStringParts(node.consequent, parts);
  staticStringParts(node.alternate, parts);
}

function collectLogicalStringParts(node, parts) {
  staticStringParts(node.left, parts);
  staticStringParts(node.right, parts);
}

function collectArrayStringParts(node, parts) {
  for (const element of node.elements ?? []) staticStringParts(element, parts);
}

function collectCallStringParts(node, parts) {
  for (const arg of node.arguments ?? []) {
    if (arg.type !== "SpreadElement") staticStringParts(arg, parts);
  }
}

function collectObjectKeyStringParts(node, parts) {
  for (const property of node.properties ?? []) {
    if (property.type === "Property") staticStringParts(property.key, parts);
  }
}

function staticStringParts(node, parts = []) {
  if (!node) return parts;
  if (node.type === "Literal" && typeof node.value === "string") {
    parts.push(node.value);
    return parts;
  }
  const collectors = {
    ArrayExpression: collectArrayStringParts,
    CallExpression: collectCallStringParts,
    ConditionalExpression: collectConditionalStringParts,
    LogicalExpression: collectLogicalStringParts,
    ObjectExpression: collectObjectKeyStringParts,
    TemplateLiteral: collectTemplateLiteralString,
  };
  collectors[node.type]?.(node, parts);
  return parts;
}

function getJsxClassNameLiterals(node) {
  if (node.name?.name !== "className") return [];
  if (node.value?.type === "Literal") return staticStringParts(node.value);
  if (node.value?.type === "JSXExpressionContainer") {
    return staticStringParts(node.value.expression);
  }
  return [];
}

// Visit free functions, arrow consts, and class methods/fields uniformly — agents hide the same
// inference-appeasement patterns in any of these forms.
const callableVisitors = (check) => ({
  FunctionDeclaration: check,
  VariableDeclarator: check,
  MethodDefinition: check,
  PropertyDefinition: check,
  Property: check,
});

function checkTrivialSelectorWrapper(node, context) {
  if (isBoundary(node)) return;
  const fn = getFunctionNode(node);
  if (!fn || !hasExplicitReturnType(fn)) return;
  if (isTrivialSelectorWrapper(fn)) {
    context.report({
      node,
      message:
        "Do not create a typed selector wrapper that only returns a property of its own parameter. Use inference directly or move the contract to the owned boundary.",
    });
  }
}

function ruleNoTrivialSelectorWrapper() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow typed selector wrappers that only restate property access.",
      },
      schema: [],
    },
    create(context) {
      return callableVisitors((node) =>
        checkTrivialSelectorWrapper(node, context),
      );
    },
  };
}

function ruleNoInlineStructuralTypeAtUseSite() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow inline object type literals at use sites.",
      },
      schema: [],
    },
    create(context) {
      return {
        TSTypeLiteral(node) {
          if (inlineStructuralTypeAtBoundary(node)) {
            context.report({
              node,
              message:
                "Do not define structural contracts at use sites. Import or create the owned named type.",
            });
          }
        },
      };
    },
  };
}

function ruleNoHandrolledResourceLifecycleCells() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell. Broad multi-setter co-mutation is inventory only, never blocking.",
      },
      schema: [
        {
          type: "object",
          properties: { threshold: { type: "number" } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const threshold = context.options[0]?.threshold ?? 3;
      const tracker = createReactStateTracker({
        onFrameExit(frame) {
          const proof = frame.isTransition
            ? lifecycleProof(frame)
            : { proven: false };
          if (proof.proven && !frame.requestGuard) {
            emitSemanticFact(context, frame.node, {
              factKind: "resourceLifecycleProof",
              ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
              adapterId: "react-state",
              confidence: "deterministic-enforcement",
              provenance: ["AST", "scope-binding", "control-flow"],
              payload: {
                boolCell: proof.boolCell,
                errorCell: proof.errorCell,
                payloadCell: proof.payloadCell,
                ...frameStatePayload(frame),
              },
            });
            context.report({
              node: frame.node,
              message:
                "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
            });
            return;
          }
          // Broad co-mutation is name-agnostic but unproven: inventory only, never blocking.
          if (frame.called.size >= threshold) {
            emitSemanticFact(context, frame.node, {
              factKind: "broadSetterCoMutation",
              ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
              adapterId: "react-state",
              confidence: "heuristic-inventory",
              provenance: ["AST", "scope-binding"],
              payload: frameStatePayload(frame),
            });
          }
        },
      });
      return tracker.visitors;
    },
  };
}

function isGlobalFetchCall(callee) {
  if (callee?.type === "Identifier") return callee.name === "fetch";
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const objectName =
    callee.object?.type === "Identifier" ? callee.object.name : "";
  const propertyName =
    callee.property?.type === "Identifier" ? callee.property.name : "";
  return (
    propertyName === "fetch" &&
    (objectName === "globalThis" ||
      objectName === "window" ||
      objectName === "self")
  );
}

function sourceShardPayload(proof) {
  return {
    source: proof.source,
    members: proof.entries.map(({ setter, cell, property }) => ({
      setter,
      cell,
      property,
    })),
    editableCells: proof.editableCells,
    transition: Boolean(proof.transition),
    requestGuard: Boolean(proof.requestGuard),
  };
}

// Type-owner tier: the behavioral shard only blocks when the awaited source resolves
// to exactly one accepted owned entity (domain or generated authority) and every
// fanned member is a property of that owned type. Reuses the same owner machinery as
// no-structural-type-fork; otherwise the shard stays inventory-only.
function sourceShardOwnedEntityProof(services, checker, proof, options) {
  if (!proof.sourceInit) return null;
  const tsSourceInit = services.esTreeNodeToTSNodeMap.get(proof.sourceInit);
  if (!tsSourceInit) return null;
  const sourceType = checker.getTypeAtLocation(tsSourceInit);
  const canonicalEntities = options.canonicalEntities ?? {};
  const generatedSources = options.generatedSources ?? {};
  const resolvesToDomain = resolvesToDomainCanonicalType(
    sourceType,
    canonicalEntities,
  );
  const resolvesToGenerated = resolvesToGeneratedType(
    sourceType,
    generatedSources,
  );
  if (Number(resolvesToDomain) + Number(resolvesToGenerated) !== 1) {
    return null;
  }
  const props = typeProps(checker, sourceType);
  if (!proof.entries.every((entry) => props.has(entry.property))) {
    return null;
  }
  return {
    authority: resolvesToDomain ? "domain" : "generated",
    typeName: checker.typeToString(sourceType),
  };
}

function ruleNoShatteredIngestedEntityState() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow splitting one freshly ingested entity object into sibling React state cells unless those cells are proven editable draft fields.",
      },
      schema: [
        {
          type: "object",
          properties: {
            threshold: { type: "number" },
            canonicalEntities: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      owner: { type: "string" },
                      exportName: { type: "string" },
                    },
                  },
                ],
              },
            },
            generatedSources: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  generated: { type: "string" },
                },
              },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-shattered-ingested-entity-state",
        );
      }
      const checker = services.program.getTypeChecker();
      const options = context.options[0] ?? {};
      const threshold = options.threshold ?? 2;
      const tracker = createReactStateTracker({
        onFrameExit(frame) {
          // Only the component frame declares useState cells; a nested async
          // transition frame has no setters and bubbles its transitions (and the
          // controlled/event-edited exclusions) up to this frame, which is the one
          // evaluated. Dropping this guard would double-evaluate without exclusions.
          if (frame.setters.size === 0) return;
          const proof = sourceShardProof(frame, { threshold });
          if (!proof.proven) return;
          const owner = sourceShardOwnedEntityProof(
            services,
            checker,
            proof,
            options,
          );
          if (!owner) {
            emitSemanticFact(context, proof.node ?? frame.node, {
              factKind: "sourceMemberStateShardCandidate",
              ruleId: "antidrift/no-shattered-ingested-entity-state",
              adapterId: "react-state",
              confidence: "heuristic-inventory",
              provenance: ["AST", "scope-binding", "control-flow"],
              payload: sourceShardPayload(proof),
            });
            return;
          }
          emitSemanticFact(context, proof.node ?? frame.node, {
            factKind: "sourceMemberStateShard",
            ruleId: "antidrift/no-shattered-ingested-entity-state",
            adapterId: "react-state",
            confidence: "deterministic-enforcement",
            provenance: ["AST", "scope-binding", "control-flow", "TypeChecker"],
            payload: {
              ...sourceShardPayload(proof),
              owner,
            },
          });
          context.report({
            node: proof.node ?? frame.node,
            message:
              "This transition splits one freshly ingested source object into sibling React state cells. Keep the entity/resource together unless these are editable draft fields.",
          });
        },
      });
      return tracker.visitors;
    },
  };
}

function ruleRequireEffectDeps() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require a dependency array for React effect hooks. A missing array runs the effect on every render — usually an agent oversight, and one exhaustive-deps does not flag (it only validates an array that already exists).",
      },
      schema: [],
    },
    create(context) {
      // Local names that resolve to a React effect hook: imported/aliased bare names, plus default
      // and namespace import names accessed as `React.useEffect`. Only react imports are tracked.
      const directNames = new Set();
      const namespaceNames = new Set();
      return {
        ImportDeclaration(node) {
          if (node.source.value !== "react") return;
          for (const spec of node.specifiers) {
            if (
              spec.type === "ImportSpecifier" &&
              reactEffectHooks.has(spec.imported.name)
            ) {
              directNames.add(spec.local.name);
            } else if (
              spec.type === "ImportDefaultSpecifier" ||
              spec.type === "ImportNamespaceSpecifier"
            ) {
              namespaceNames.add(spec.local.name);
            }
          }
        },
        CallExpression(node) {
          const callee = node.callee;
          let hookName = null;
          if (callee.type === "Identifier" && directNames.has(callee.name)) {
            hookName = callee.name;
          } else if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            callee.property.type === "Identifier" &&
            namespaceNames.has(callee.object.name) &&
            reactEffectHooks.has(callee.property.name)
          ) {
            hookName = callee.property.name;
          }
          if (hookName && node.arguments.length < 2) {
            context.report({
              node,
              message: `${hookName} must be called with a dependency array. Without it the effect runs on every render — pass [] or the real dependencies.`,
            });
          }
        },
      };
    },
  };
}

function ruleClassNamePattern(name, pattern, message) {
  return createRule({
    name,
    meta: {
      type: "problem",
      docs: { description: message },
      messages: { forbiddenClassName: message },
      schema: [],
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node) {
          if (
            getJsxClassNameLiterals(node).some((className) =>
              pattern.test(className),
            )
          ) {
            context.report({ node, messageId: "forbiddenClassName" });
          }
        },
      };
    },
  });
}

function ruleNoRawFetchInComponent() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow raw fetch calls inside React components.",
      },
      schema: [],
    },
    create(context) {
      const filename = context.filename ?? context.getFilename();
      const isComponentModule = /\.(?:jsx|tsx)$/u.test(filename);
      const stack = [];
      const moduleFetches = [];
      const reportedFetches = new WeakSet();
      let sawJsxInFile = false;
      function enterFunction(node) {
        stack.push({
          node,
          name: getFunctionName(node),
          sawJsx: false,
          sawFetch: null,
        });
      }
      function reportFetch(node, message) {
        if (reportedFetches.has(node)) return;
        reportedFetches.add(node);
        context.report({ node, message });
      }
      function exitFunction() {
        const frame = stack.pop();
        if (
          frame?.sawFetch &&
          (frame.sawJsx || isReactComponentName(frame.name))
        ) {
          reportFetch(
            frame.sawFetch,
            "Do not call raw fetch inside React components. Use an API client, loader, or query resource.",
          );
        }
      }

      return {
        FunctionDeclaration: enterFunction,
        "FunctionDeclaration:exit": exitFunction,
        FunctionExpression: enterFunction,
        "FunctionExpression:exit": exitFunction,
        ArrowFunctionExpression: enterFunction,
        "ArrowFunctionExpression:exit": exitFunction,
        JSXElement() {
          sawJsxInFile = true;
          if (stack.length > 0) stack[stack.length - 1].sawJsx = true;
        },
        CallExpression(node) {
          if (isGlobalFetchCall(node.callee) && stack.length > 0) {
            const frame = stack[stack.length - 1];
            frame.sawFetch = node;
            if (!isReactComponentName(frame.name)) moduleFetches.push(node);
          }
        },
        "Program:exit"() {
          if (!isComponentModule || !sawJsxInFile) return;
          for (const node of moduleFetches) {
            reportFetch(
              node,
              "Do not call raw fetch inside React component modules. Move transport logic to an API client, loader, or query resource.",
            );
          }
        },
      };
    },
  };
}

function asyncMapMessage(method) {
  return `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`;
}

function ruleNoAsyncArrayMethod() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises.",
      },
      schema: [],
    },
    create(context) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const pendingAsyncMaps = [];
      return {
        "Program:exit"() {
          for (const pending of pendingAsyncMaps) {
            if (!pending.awaited) {
              context.report({
                node: pending.node,
                message: asyncMapMessage(pending.method),
              });
            }
          }
        },
        CallExpression(node) {
          markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps);
          const classification = asyncArrayCallbackClassification(node);
          if (!classification) return;
          const { callback, method } = classification;
          if (classification.kind === "never-await") {
            context.report({
              node: callback,
              message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.`,
            });
            return;
          }
          if (classification.kind === "requires-collection") {
            if (isDirectlyWrappedInPromiseCombinator(node)) return;
            if (
              queuePendingAsyncMap(
                sourceCode,
                node,
                callback,
                method,
                pendingAsyncMaps,
              )
            ) {
              return;
            }
            context.report({
              node: callback,
              message: asyncMapMessage(method),
            });
          }
        },
      };
    },
  };
}

const sqlPattern =
  /\b(?:SELECT\b[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
const sqlSentencePattern =
  /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
const parameterizedSqlTagNames = new Set(["sql", "sqlQuery", "sqlRun"]);

function templateText(node) {
  return node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "")
    .join(" ");
}

function staticStringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return templateText(node);
  }
  return null;
}

function singleReturnExpression(node) {
  if (!node) return null;
  if (
    node.type === "ArrowFunctionExpression" &&
    node.body?.type !== "BlockStatement"
  ) {
    return node.body;
  }
  if (node.body?.type !== "BlockStatement" || node.body.body.length !== 1) {
    return null;
  }
  const statement = node.body.body[0];
  return statement?.type === "ReturnStatement" ? statement.argument : null;
}

function isEscapedReplaceCall(node, paramName, quote) {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  if (
    callee.object?.type !== "Identifier" ||
    callee.object.name !== paramName
  ) {
    return false;
  }
  if (
    callee.property?.type !== "Identifier" ||
    callee.property.name !== "replace"
  ) {
    return false;
  }
  const [pattern, replacement] = node.arguments;
  const patternMatches =
    pattern?.type === "Literal" &&
    ((pattern.regex &&
      pattern.regex.pattern === quote &&
      pattern.regex.flags.includes("g")) ||
      pattern.value === quote);
  return (
    patternMatches && staticStringValue(replacement) === `${quote}${quote}`
  );
}

function sqlEscaperKindFromReturnExpression(node, paramName) {
  if (node?.type !== "TemplateLiteral" || node.expressions.length !== 1) {
    return null;
  }
  const before =
    node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? "";
  const after = node.quasis[1]?.value.cooked ?? node.quasis[1]?.value.raw ?? "";
  if (
    before === '"' &&
    after === '"' &&
    isEscapedReplaceCall(node.expressions[0], paramName, '"')
  ) {
    return "identifier";
  }
  if (
    before === "'" &&
    after === "'" &&
    isEscapedReplaceCall(node.expressions[0], paramName, "'")
  ) {
    return "string";
  }
  return null;
}

function sqlEscaperFunctionKind(node) {
  if (
    node?.type !== "FunctionDeclaration" &&
    node?.type !== "FunctionExpression" &&
    node?.type !== "ArrowFunctionExpression"
  ) {
    return null;
  }
  const param = node.params?.[0];
  if (node.params.length !== 1 || param?.type !== "Identifier") return null;
  return sqlEscaperKindFromReturnExpression(
    singleReturnExpression(node),
    param.name,
  );
}

function tsStaticStringValue(node) {
  if (!node) return null;
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function tsSingleReturnExpression(node) {
  if (!node?.body) return null;
  if (!ts.isBlock(node.body)) return node.body;
  if (node.body.statements.length !== 1) return null;
  const statement = node.body.statements[0];
  return ts.isReturnStatement(statement)
    ? (statement.expression ?? null)
    : null;
}

function tsTemplateParts(node) {
  if (!node || !ts.isTemplateExpression(node)) return null;
  return {
    expressions: node.templateSpans.map((span) => span.expression),
    parts: [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ],
  };
}

function tsRegexMatchesGlobalQuote(node, quote) {
  if (!ts.isRegularExpressionLiteral(node)) return false;
  const text = node.getText();
  if (!text.endsWith("g")) return false;
  return text === `/${quote}/g`;
}

function tsEscapedReplaceCall(node, paramName, quote) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (method !== "replace" && method !== "replaceAll") return false;
  const receiver = node.expression.expression;
  let receiverRoot = null;
  if (ts.isIdentifier(receiver)) {
    receiverRoot = receiver;
  } else if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression)
  ) {
    receiverRoot = receiver.expression;
  }
  if (receiverRoot?.text !== paramName) return false;
  const [pattern, replacement] = node.arguments;
  const patternMatches =
    method === "replaceAll"
      ? tsStaticStringValue(pattern) === quote
      : tsRegexMatchesGlobalQuote(pattern, quote);
  return (
    patternMatches && tsStaticStringValue(replacement) === `${quote}${quote}`
  );
}

function tsTemplateSqlEscaperKind(node, paramName) {
  const template = tsTemplateParts(node);
  if (!template || template.expressions.length === 0) return null;
  const skeleton = template.parts.join("A");
  const isIdentifierSkeleton = /^(?:"A"|`A`)(?:\.(?:"A"|`A`))*$/u.test(
    skeleton,
  );
  const isStringSkeleton = skeleton === "'A'";
  if (!isIdentifierSkeleton && !isStringSkeleton) return null;
  const expectedQuotes = template.expressions.map((_, index) => {
    const before = template.parts[index];
    const after = template.parts[index + 1];
    const quote = before.at(-1);
    return quote && quote === after?.[0] ? quote : null;
  });
  if (
    expectedQuotes.some(
      (quote) => quote !== '"' && quote !== "'" && quote !== "`",
    )
  ) {
    return null;
  }
  if (
    !template.expressions.every((expression, index) =>
      tsEscapedReplaceCall(expression, paramName, expectedQuotes[index]),
    )
  ) {
    return null;
  }
  return isStringSkeleton ? "string" : "identifier";
}

function tsSqlEscaperDeclarationKind(node) {
  if (!node) return null;
  let fn = null;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    fn = node;
  } else if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isFunctionExpression(node.initializer) ||
      ts.isArrowFunction(node.initializer))
  ) {
    fn = node.initializer;
  }
  if (!fn || fn.parameters.length !== 1) return null;
  const param = fn.parameters[0];
  if (!ts.isIdentifier(param.name)) return null;
  return tsTemplateSqlEscaperKind(
    tsSingleReturnExpression(fn),
    param.name.text,
  );
}

function hasOpenSqlQuote(value, quote) {
  let open = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== quote) continue;
    if (value[i + 1] === quote) {
      i += 1;
      continue;
    }
    open = !open;
  }
  return open;
}

function isUnquotedSqlInterpolation(before, after) {
  if (
    hasOpenSqlQuote(before, "'") ||
    hasOpenSqlQuote(before, '"') ||
    hasOpenSqlQuote(before, "`")
  ) {
    return false;
  }
  return !/^\s*['"`]/u.test(after);
}

function intersectPropertySets(left, right) {
  if (!left) return new Set(right);
  return new Set([...left].filter((key) => right.has(key)));
}

function collectReturnArguments(node, out) {
  if (!node) return;
  if (node.type === "ReturnStatement") {
    out.push(node.argument);
    return;
  }
  if (node.type === "BlockStatement") {
    for (const statement of node.body ?? []) {
      collectReturnArguments(statement, out);
    }
    return;
  }
  if (node.type === "IfStatement") {
    collectReturnArguments(node.consequent, out);
    collectReturnArguments(node.alternate, out);
  }
}

function isStaticStringCallback(node) {
  if (
    node?.type !== "ArrowFunctionExpression" &&
    node?.type !== "FunctionExpression"
  ) {
    return false;
  }
  return staticStringValue(node.body) !== null;
}

function isStaticFragmentMapJoin(node) {
  if (node?.type !== "CallExpression") return false;
  const join = node.callee;
  if (
    join?.type !== "MemberExpression" ||
    join.computed ||
    join.property?.type !== "Identifier" ||
    join.property.name !== "join"
  ) {
    return false;
  }
  const separator = node.arguments[0]
    ? staticStringValue(node.arguments[0])
    : ",";
  if (!isAllowedSqlFragmentJoinSeparator(separator)) return false;
  const mapCall = join.object;
  if (mapCall?.type !== "CallExpression") return false;
  const map = mapCall.callee;
  return (
    map?.type === "MemberExpression" &&
    !map.computed &&
    map.property?.type === "Identifier" &&
    map.property.name === "map" &&
    isStaticStringCallback(mapCall.arguments[0])
  );
}

function isIndexArithmeticExpression(node, indexName) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type === "Identifier") return unwrapped.name === indexName;
  if (unwrapped?.type === "Literal") return typeof unwrapped.value === "number";
  if (
    unwrapped?.type !== "BinaryExpression" ||
    !["+", "*"].includes(unwrapped.operator)
  ) {
    return false;
  }
  return (
    isIndexArithmeticExpression(unwrapped.left, indexName) &&
    isIndexArithmeticExpression(unwrapped.right, indexName)
  );
}

function isPostgresPlaceholderTemplate(node, indexName) {
  if (node?.type !== "TemplateLiteral" || node.expressions.length === 0) {
    return false;
  }
  for (let index = 0; index < node.expressions.length; index += 1) {
    const before =
      node.quasis[index]?.value?.cooked ?? node.quasis[index]?.value?.raw ?? "";
    const after =
      node.quasis[index + 1]?.value?.cooked ??
      node.quasis[index + 1]?.value?.raw ??
      "";
    if (!before.endsWith("$") || /^\d/u.test(after)) return false;
    if (!isIndexArithmeticExpression(node.expressions[index], indexName)) {
      return false;
    }
  }
  return true;
}

function isPlaceholderSqlFragmentMapJoin(node) {
  if (node?.type !== "CallExpression") return false;
  const join = node.callee;
  if (
    join?.type !== "MemberExpression" ||
    join.computed ||
    join.property?.type !== "Identifier" ||
    join.property.name !== "join"
  ) {
    return false;
  }
  const separator = node.arguments[0]
    ? staticStringValue(node.arguments[0])
    : ",";
  if (separator !== " OR " && separator !== " AND ") return false;
  const mapCall = join.object;
  if (mapCall?.type !== "CallExpression") return false;
  const map = mapCall.callee;
  if (
    map?.type !== "MemberExpression" ||
    map.computed ||
    map.property?.type !== "Identifier" ||
    map.property.name !== "map"
  ) {
    return false;
  }
  const callback = mapCall.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const indexParam = callback.params?.[1];
  if (indexParam?.type !== "Identifier") return false;
  return isPostgresPlaceholderTemplate(
    singleReturnExpression(callback),
    indexParam.name,
  );
}

function isEmptyArrayExpression(node) {
  return node?.type === "ArrayExpression" && node.elements.length === 0;
}

function isParameterizedSqlTag(node) {
  if (node?.type === "Identifier") {
    return parameterizedSqlTagNames.has(node.name);
  }
  if (node?.type === "ChainExpression") {
    return isParameterizedSqlTag(node.expression);
  }
  if (node?.type !== "MemberExpression" || node.computed) return false;
  return (
    node.property?.type === "Identifier" &&
    parameterizedSqlTagNames.has(node.property.name)
  );
}

function isAllowedSqlFragmentJoinSeparator(value) {
  return (
    value === "," || value === ", " || value === " AND " || value === " OR "
  );
}

function sqlStringValuesFromType(typeNode) {
  if (!typeNode) return null;
  if (typeNode.type === "TSUnionType") {
    const values = new Set();
    for (const part of typeNode.types) {
      const partValues = sqlStringValuesFromType(part);
      if (!partValues) return null;
      for (const value of partValues) values.add(value);
    }
    return values;
  }
  if (typeNode.type !== "TSLiteralType") return null;
  const literal = typeNode.literal;
  return literal?.type === "Literal" && typeof literal.value === "string"
    ? new Set([literal.value])
    : null;
}

function sqlTypePropertyValues(typeNode, propertyName) {
  if (typeNode?.type !== "TSTypeLiteral") return null;
  for (const member of typeNode.members ?? []) {
    if (member.type !== "TSPropertySignature") continue;
    const keyName = sqlPropertyKeyName(member.key);
    if (keyName === propertyName) {
      return sqlStringValuesFromType(member.typeAnnotation?.typeAnnotation);
    }
  }
  return null;
}

function sqlPropertyKeyName(key) {
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal") return String(key.value);
  return "";
}

function charClassAllowsOnlySqlIdentifierChars(value, { allowDigit }) {
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    const next = value[i + 1];
    const end = value[i + 2];
    if (next === "-" && end) {
      const range = `${char}-${end}`;
      if (
        range !== "a-z" &&
        range !== "A-Z" &&
        (!allowDigit || range !== "0-9")
      ) {
        return false;
      }
      i += 3;
    } else {
      const isLetter = /[A-Za-z]/u.test(char);
      const isDigit = /\d/u.test(char);
      if (!isLetter && char !== "_" && (!allowDigit || !isDigit)) return false;
      i += 1;
    }
  }
  return true;
}

function isSqlIdentifierRegexLiteral(node) {
  const pattern =
    node?.type === "Literal" && node.regex ? node.regex.pattern : "";
  const match = /^\^\[([^\]]+)\]\[([^\]]+)\]\*\$$/u.exec(pattern);
  if (!match) return false;
  return (
    charClassAllowsOnlySqlIdentifierChars(match[1], { allowDigit: false }) &&
    charClassAllowsOnlySqlIdentifierChars(match[2], { allowDigit: true })
  );
}

function assignedSqlIdentifierNode(node) {
  if (node.left?.type === "Identifier") return node.left;
  if (
    node.left?.type === "MemberExpression" &&
    node.left.object?.type === "Identifier"
  ) {
    return node.left.object;
  }
  return null;
}

function classMemberKey(node) {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  if (
    node.object?.type !== "ThisExpression" ||
    node.property?.type !== "Identifier"
  ) {
    return null;
  }
  return node.property.name;
}

function enclosingClass(node) {
  let cur = node?.parent ?? null;
  while (cur) {
    if (cur.type === "ClassDeclaration" || cur.type === "ClassExpression") {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function statementExits(node) {
  if (!node) return false;
  if (node.type === "ThrowStatement" || node.type === "ReturnStatement") {
    return true;
  }
  if (node.type === "BlockStatement") return statementExits(node.body.at(-1));
  if (node.type === "IfStatement") {
    return statementExits(node.consequent) && statementExits(node.alternate);
  }
  return false;
}

function unionStringValues(left, right) {
  if (!left || !right) return null;
  return new Set([...left, ...right]);
}

function variableTypeNode(variable) {
  const def = variable?.defs?.[0];
  return (
    def?.name?.typeAnnotation?.typeAnnotation ??
    def?.node?.typeAnnotation?.typeAnnotation ??
    def?.node?.id?.typeAnnotation?.typeAnnotation ??
    null
  );
}

function objectLiteralIdentifierValues(node) {
  if (node?.type !== "ObjectExpression") return null;
  const values = new Set();
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") return null;
    const value = staticStringValue(property.value);
    if (!value || !isSqlIdentifierTokenValue(value)) return null;
    values.add(value);
  }
  return values;
}

function templateInterpolationParts(node, index) {
  return {
    before:
      node.quasis[index]?.value?.cooked ?? node.quasis[index]?.value?.raw ?? "",
    after:
      node.quasis[index + 1]?.value?.cooked ??
      node.quasis[index + 1]?.value?.raw ??
      "",
  };
}

function ruleNoSqlStringConcat() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow SQL assembled via string interpolation or concatenation.",
      },
      schema: [
        {
          type: "object",
          properties: {
            safeIdentifierMembers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  member: { type: "string" },
                  evidence: { type: "string" },
                },
                required: ["type", "member"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const sourceCode = context.sourceCode;
      const safeIdentifierMembers = safeIdentifierMemberSpecs(
        context.options[0] ?? {},
      );
      const services = requireTypeServices(context);
      const checker = services?.program?.getTypeChecker() ?? null;
      const safeSqlFragmentArrays = new WeakSet();
      const safeSqlFragmentStrings = new WeakSet();
      const safeSqlFragmentObjectValues = new WeakMap();
      const safeSqlIdentifierValues = new WeakMap();
      const safeSqlIdentifierObjectValues = new WeakMap();
      const safeDynamicSqlIdentifierVariables = new WeakSet();
      const safeDynamicSqlIdentifierMembers = new WeakMap();
      const sqlIdentifierRegexVariables = new WeakSet();
      const sqlEscaperFunctions = new WeakMap();
      const importedSqlEscaperDeclarations = new WeakMap();
      const safeSqlFragmentFunctions = new WeakMap();
      function isSafeFragmentVariable(node, set) {
        const variable = findVariable(sourceCode, node);
        return Boolean(variable && set.has(variable));
      }
      function isSafeFragmentMember(node) {
        if (
          node?.type !== "MemberExpression" ||
          node.computed ||
          node.object?.type !== "Identifier" ||
          node.property?.type !== "Identifier"
        ) {
          return false;
        }
        const variable = findVariable(sourceCode, node.object);
        const properties = variable
          ? safeSqlFragmentObjectValues.get(variable)
          : null;
        return Boolean(properties?.has(node.property.name));
      }
      function markSqlEscaperFunction(node) {
        const kind = sqlEscaperFunctionKind(getFunctionNode(node));
        if (!kind) return;
        const variable = getDeclaredVariable(sourceCode, node);
        if (variable) sqlEscaperFunctions.set(variable, kind);
      }
      function scanSqlEscaperDeclaration(node) {
        const declaration =
          node?.type === "ExportNamedDeclaration" ||
          node?.type === "ExportDefaultDeclaration"
            ? node.declaration
            : node;
        if (declaration?.type === "FunctionDeclaration") {
          markSqlEscaperFunction(declaration);
          return;
        }
        if (declaration?.type !== "VariableDeclaration") return;
        for (const declarator of declaration.declarations ?? []) {
          markSqlEscaperFunction(declarator);
        }
      }
      function sqlEscaperCallbackKind(node) {
        if (node?.type === "Identifier") {
          const variable = findVariable(sourceCode, node);
          return variable
            ? (sqlEscaperFunctions.get(variable) ??
                importedSqlEscaperKind(node))
            : importedSqlEscaperKind(node);
        }
        return sqlEscaperFunctionKind(node);
      }
      function importedSqlEscaperKind(node) {
        if (
          !checker ||
          !services?.esTreeNodeToTSNodeMap ||
          node?.type !== "Identifier"
        ) {
          return null;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const symbol = tsNode && checker.getSymbolAtLocation(tsNode);
        const resolved =
          symbol && symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        for (const declaration of resolved?.declarations ?? []) {
          if (importedSqlEscaperDeclarations.has(declaration)) {
            return importedSqlEscaperDeclarations.get(declaration);
          }
          const kind = tsSqlEscaperDeclarationKind(declaration);
          importedSqlEscaperDeclarations.set(declaration, kind);
          if (kind) return kind;
        }
        return null;
      }
      function sqlEscaperCallKind(node) {
        if (node?.type !== "CallExpression" || node.arguments.length !== 1) {
          return null;
        }
        if (node.callee?.type !== "Identifier") return null;
        const variable = findVariable(sourceCode, node.callee);
        return variable
          ? (sqlEscaperFunctions.get(variable) ??
              importedSqlEscaperKind(node.callee))
          : importedSqlEscaperKind(node.callee);
      }
      function safeSqlFragmentFunctionSummary(node) {
        const fn = getFunctionNode(node);
        if (
          fn?.type !== "FunctionDeclaration" &&
          fn?.type !== "FunctionExpression" &&
          fn?.type !== "ArrowFunctionExpression"
        ) {
          return null;
        }
        const params = fn.params ?? [];
        if (params.some((param) => param.type !== "Identifier")) return null;
        const paramNames = new Set(params.map((param) => param.name));
        const identifierParams = new Set();
        if (
          !isSafeSqlFragmentExpressionForSummary(
            singleReturnExpression(fn),
            paramNames,
            identifierParams,
          )
        ) {
          return null;
        }
        return {
          arity: params.length,
          identifierParams: params
            .map((param, index) =>
              identifierParams.has(param.name) ? index : null,
            )
            .filter((index) => index !== null),
        };
      }
      function markSafeSqlFragmentFunction(node) {
        const summary = safeSqlFragmentFunctionSummary(node);
        if (!summary) return;
        const variable = getDeclaredVariable(sourceCode, node);
        if (variable) safeSqlFragmentFunctions.set(variable, summary);
      }
      function scanSafeSqlFragmentDeclaration(node) {
        const declaration =
          node?.type === "ExportNamedDeclaration" ||
          node?.type === "ExportDefaultDeclaration"
            ? node.declaration
            : node;
        if (declaration?.type === "FunctionDeclaration") {
          markSafeSqlFragmentFunction(declaration);
          return;
        }
        if (declaration?.type !== "VariableDeclaration") return;
        for (const declarator of declaration.declarations ?? []) {
          markSafeSqlFragmentFunction(declarator);
        }
      }
      function safeSqlFragmentCallSummary(node) {
        if (
          node?.type !== "CallExpression" ||
          node.callee?.type !== "Identifier"
        ) {
          return null;
        }
        const variable = findVariable(sourceCode, node.callee);
        return variable
          ? (safeSqlFragmentFunctions.get(variable) ?? null)
          : null;
      }
      function isSafeSqlFragmentCall(node) {
        const summary = safeSqlFragmentCallSummary(node);
        if (!summary || node.arguments.length !== summary.arity) return false;
        return summary.identifierParams.every((index) =>
          isSafeSqlIdentifierExpression(node.arguments[index]),
        );
      }
      function isSqlEscaperMapJoin(node, kind, separators) {
        if (node?.type !== "CallExpression") return false;
        const join = node.callee;
        if (
          join?.type !== "MemberExpression" ||
          join.computed ||
          join.property?.type !== "Identifier" ||
          join.property.name !== "join"
        ) {
          return false;
        }
        const separator = node.arguments[0]
          ? staticStringValue(node.arguments[0])
          : ",";
        if (!separators.has(separator)) return false;
        const mapCall = join.object;
        if (mapCall?.type !== "CallExpression") return false;
        const map = mapCall.callee;
        return (
          map?.type === "MemberExpression" &&
          !map.computed &&
          map.property?.type === "Identifier" &&
          map.property.name === "map" &&
          sqlEscaperCallbackKind(mapCall.arguments[0]) === kind
        );
      }
      function isSafeSqlFragmentMapJoinForSummary(
        node,
        paramNames,
        identifierParams,
      ) {
        if (node?.type !== "CallExpression") return false;
        const join = node.callee;
        if (
          join?.type !== "MemberExpression" ||
          join.computed ||
          join.property?.type !== "Identifier" ||
          join.property.name !== "join"
        ) {
          return false;
        }
        const separator = node.arguments[0]
          ? staticStringValue(node.arguments[0])
          : ",";
        if (
          !isAllowedSqlFragmentJoinSeparator(separator) &&
          separator !== "\n"
        ) {
          return false;
        }
        const mapCall = join.object;
        if (mapCall?.type !== "CallExpression") return false;
        const map = mapCall.callee;
        if (
          map?.type !== "MemberExpression" ||
          map.computed ||
          map.property?.type !== "Identifier" ||
          map.property.name !== "map"
        ) {
          return false;
        }
        const callback = mapCall.arguments[0];
        if (
          callback?.type !== "ArrowFunctionExpression" &&
          callback?.type !== "FunctionExpression"
        ) {
          return false;
        }
        return isSafeSqlFragmentExpressionForSummary(
          singleReturnExpression(callback),
          paramNames,
          identifierParams,
        );
      }
      function isSafeSqlFragmentTemplateForSummary(
        node,
        paramNames,
        identifierParams,
      ) {
        if (node?.type !== "TemplateLiteral") return false;
        for (let i = 0; i < node.expressions.length; i += 1) {
          const expression = node.expressions[i];
          const { before, after } = templateInterpolationParts(node, i);
          if (
            expression.type === "Identifier" &&
            paramNames.has(expression.name)
          ) {
            if (!isUnquotedSqlInterpolation(before, after)) return false;
            identifierParams.add(expression.name);
            continue;
          }
          if (
            !isSafeSqlFragmentExpressionForSummary(
              expression,
              paramNames,
              identifierParams,
            )
          ) {
            return false;
          }
        }
        return true;
      }
      function isSafeSqlFragmentExpressionForSummary(
        node,
        paramNames,
        identifierParams,
      ) {
        if (staticStringValue(node) !== null) return true;
        if (sqlEscaperCallKind(node) === "string") return true;
        if (isSqlEscaperMapJoin(node, "string", new Set([",", ", "]))) {
          return true;
        }
        if (node?.type === "TemplateLiteral") {
          return isSafeSqlFragmentTemplateForSummary(
            node,
            paramNames,
            identifierParams,
          );
        }
        if (node?.type === "CallExpression") {
          return isSafeSqlFragmentMapJoinForSummary(
            node,
            paramNames,
            identifierParams,
          );
        }
        return false;
      }
      function markDynamicSqlIdentifierVariable(node) {
        const variable = findVariable(sourceCode, node);
        if (variable) safeDynamicSqlIdentifierVariables.add(variable);
      }
      function unmarkSqlIdentifierVariable(variable) {
        safeSqlIdentifierValues.delete(variable);
        safeSqlIdentifierObjectValues.delete(variable);
        safeSqlFragmentObjectValues.delete(variable);
        safeDynamicSqlIdentifierVariables.delete(variable);
      }
      function classSafeMembers(classNode) {
        let members = safeDynamicSqlIdentifierMembers.get(classNode);
        if (!members) {
          members = new Set();
          safeDynamicSqlIdentifierMembers.set(classNode, members);
        }
        return members;
      }
      function markDynamicSqlIdentifierMember(node) {
        const key = classMemberKey(node);
        const classNode = key && enclosingClass(node);
        if (key && classNode) classSafeMembers(classNode).add(key);
      }
      function unmarkDynamicSqlIdentifierMember(node) {
        const key = classMemberKey(node);
        const classNode = key && enclosingClass(node);
        const members = classNode
          ? safeDynamicSqlIdentifierMembers.get(classNode)
          : null;
        if (key && members) members.delete(key);
      }
      function memberTypeStringValues(node) {
        if (
          node?.type !== "MemberExpression" ||
          node.computed ||
          node.object?.type !== "Identifier"
        ) {
          return null;
        }
        const propertyName =
          node.property?.type === "Identifier" ? node.property.name : "";
        if (!propertyName) return null;
        return sqlTypePropertyValues(
          variableTypeNode(findVariable(sourceCode, node.object)),
          propertyName,
        );
      }
      function identifierTokenValues(node) {
        const variable = findVariable(sourceCode, node);
        return variable
          ? (safeSqlIdentifierValues.get(variable) ?? null)
          : null;
      }
      function isSafeDynamicSqlIdentifierVariable(node) {
        const variable =
          node?.type === "Identifier" ? findVariable(sourceCode, node) : null;
        return Boolean(
          variable && safeDynamicSqlIdentifierVariables.has(variable),
        );
      }
      function isSafeDynamicSqlIdentifierMember(node) {
        const key = classMemberKey(node);
        const classNode = key && enclosingClass(node);
        const members = classNode
          ? safeDynamicSqlIdentifierMembers.get(classNode)
          : null;
        return Boolean(key && members?.has(key));
      }
      function typeNames(type) {
        return new Set(
          [
            checker.typeToString(type),
            type.getSymbol()?.getName(),
            type.aliasSymbol?.getName(),
          ].filter(Boolean),
        );
      }
      function isConfiguredSafeSqlIdentifierMember(node) {
        if (!checker || safeIdentifierMembers.length === 0) return false;
        if (
          node?.type !== "MemberExpression" ||
          node.computed ||
          node.property?.type !== "Identifier"
        ) {
          return false;
        }
        const candidates = safeIdentifierMembers.filter(
          ({ member }) => member === node.property.name,
        );
        if (candidates.length === 0) return false;
        const tsObject = services?.esTreeNodeToTSNodeMap?.get(node.object);
        if (!tsObject) return false;
        const names = typeNames(checker.getTypeAtLocation(tsObject));
        return candidates.some(({ type }) => names.has(type));
      }
      function memberTokenValues(node) {
        if (node.computed && node.object?.type === "Identifier") {
          const variable = findVariable(sourceCode, node.object);
          return variable
            ? (safeSqlIdentifierObjectValues.get(variable) ?? null)
            : null;
        }
        return memberTypeStringValues(node);
      }
      function transformedCallTokenValues(node) {
        if (node.arguments.length > 0) return null;
        const callee = node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.type !== "Identifier"
        ) {
          return null;
        }
        const sourceValues = sqlTokenValues(callee.object);
        if (!sourceValues) return null;
        if (callee.property.name === "toUpperCase") {
          return new Set([...sourceValues].map((value) => value.toUpperCase()));
        }
        if (callee.property.name === "toLowerCase") {
          return new Set([...sourceValues].map((value) => value.toLowerCase()));
        }
        return null;
      }
      function sqlTokenValues(node) {
        const staticValue = staticStringValue(node);
        if (staticValue !== null) return new Set([staticValue]);
        const unwrapped = unwrapExpression(node);
        if (unwrapped !== node) return sqlTokenValues(unwrapped);
        if (node?.type === "Identifier") return identifierTokenValues(node);
        if (node?.type === "MemberExpression") return memberTokenValues(node);
        if (
          node?.type === "LogicalExpression" &&
          (node.operator === "??" || node.operator === "||")
        ) {
          return unionStringValues(
            sqlTokenValues(node.left),
            sqlTokenValues(node.right),
          );
        }
        if (node?.type === "ConditionalExpression") {
          return unionStringValues(
            sqlTokenValues(node.consequent),
            sqlTokenValues(node.alternate),
          );
        }
        if (node?.type === "CallExpression") {
          return transformedCallTokenValues(node);
        }
        return null;
      }
      function isSafeDynamicSqlIdentifierTemplate(node) {
        return (
          node?.type === "TemplateLiteral" &&
          node.expressions.length > 0 &&
          templateStaticPartsAreSqlIdentifierSafe(node) &&
          node.expressions.every(isSafeSqlIdentifierExpression)
        );
      }
      function isSafeSqlIdentifierExpression(node) {
        if (sqlEscaperCallKind(node) === "identifier") return true;
        if (isSqlEscaperMapJoin(node, "identifier", new Set(["."]))) {
          return true;
        }
        const values = sqlTokenValues(node);
        if (valuesAreSqlIdentifiers(values)) return true;
        if (isSafeDynamicSqlIdentifierVariable(node)) return true;
        if (isConfiguredSafeSqlIdentifierMember(node)) return true;
        if (
          node?.type === "MemberExpression" &&
          isSafeDynamicSqlIdentifierMember(node)
        ) {
          return true;
        }
        return isSafeDynamicSqlIdentifierTemplate(node);
      }
      function safeSqlInterpolationState(
        expression,
        before,
        after,
        previousWasIdentifier,
      ) {
        if (isSafeSqlFragmentExpression(expression)) {
          return { safe: true, previousWasIdentifier: false };
        }
        if (
          isSafeSqlIdentifierExpression(expression) &&
          isSqlIdentifierContext(before, after)
        ) {
          return { safe: true, previousWasIdentifier: true };
        }
        const values = sqlTokenValues(expression);
        if (
          valuesAreSqlDirections(values) &&
          previousWasIdentifier &&
          /^\s*$/u.test(before)
        ) {
          return { safe: true, previousWasIdentifier: false };
        }
        return { safe: false, previousWasIdentifier: false };
      }
      function isSafeSqlTemplateLiteral(node) {
        let previousWasIdentifier = false;
        for (let i = 0; i < node.expressions.length; i += 1) {
          const expression = node.expressions[i];
          const { before, after } = templateInterpolationParts(node, i);
          const state = safeSqlInterpolationState(
            expression,
            before,
            after,
            previousWasIdentifier,
          );
          if (!state.safe) return false;
          previousWasIdentifier = state.previousWasIdentifier;
        }
        return true;
      }
      function hasUnsafeSqlInterpolation(node) {
        let previousWasIdentifier = false;
        for (let i = 0; i < node.expressions.length; i += 1) {
          const expression = node.expressions[i];
          const { before, after } = templateInterpolationParts(node, i);
          const state = safeSqlInterpolationState(
            expression,
            before,
            after,
            previousWasIdentifier,
          );
          if (!state.safe && isSqlInterpolationContext(before, after)) {
            return true;
          }
          previousWasIdentifier = state.previousWasIdentifier;
        }
        return false;
      }
      function isDirectSafeSqlFragmentExpression(node) {
        return (
          staticStringValue(node) !== null ||
          sqlEscaperCallKind(node) === "string" ||
          isSafeSqlFragmentCall(node) ||
          isSqlEscaperMapJoin(node, "string", new Set([",", ", "])) ||
          isStaticFragmentMapJoin(node) ||
          isPlaceholderSqlFragmentMapJoin(node)
        );
      }
      function isSafeSqlFragmentExpression(node) {
        if (isDirectSafeSqlFragmentExpression(node)) return true;
        if (node?.type === "Identifier") {
          return isSafeFragmentVariable(node, safeSqlFragmentStrings);
        }
        if (isSafeFragmentMember(node)) return true;
        if (node?.type === "ConditionalExpression") {
          return (
            isSafeSqlFragmentExpression(node.consequent) &&
            isSafeSqlFragmentExpression(node.alternate)
          );
        }
        if (node?.type === "TemplateLiteral") {
          return isSafeSqlTemplateLiteral(node);
        }
        if (node?.type !== "CallExpression") return false;
        const join = node.callee;
        if (
          join?.type !== "MemberExpression" ||
          join.computed ||
          join.property?.type !== "Identifier" ||
          join.property.name !== "join"
        ) {
          return false;
        }
        const separator = node.arguments[0]
          ? staticStringValue(node.arguments[0])
          : ",";
        if (!isAllowedSqlFragmentJoinSeparator(separator)) return false;
        return (
          join.object?.type === "Identifier" &&
          isSafeFragmentVariable(join.object, safeSqlFragmentArrays)
        );
      }
      function isSafeSqlFragmentArrayExpression(node) {
        return (
          isEmptyArrayExpression(node) ||
          (node?.type === "ArrayExpression" &&
            node.elements.every(
              (element) =>
                element &&
                element.type !== "SpreadElement" &&
                isSafeSqlFragmentExpression(element),
            ))
        );
      }
      function objectSqlFragmentProperties(node) {
        if (node?.type !== "ObjectExpression") return null;
        const properties = new Set();
        for (const property of node.properties ?? []) {
          if (property.type !== "Property" || property.computed) return null;
          const key = sqlPropertyKeyName(property.key);
          if (!key || !isSafeSqlFragmentExpression(property.value)) return null;
          properties.add(key);
        }
        return properties;
      }
      function returnedObjectSqlFragmentProperties(node) {
        const returns = [];
        collectReturnArguments(node, returns);
        if (returns.length === 0) return null;
        let properties = null;
        for (const argument of returns) {
          const returned = objectSqlFragmentProperties(argument);
          if (!returned) return null;
          properties = intersectPropertySets(properties, returned);
        }
        return properties;
      }
      function iifeObjectSqlFragmentProperties(node) {
        if (node?.type !== "CallExpression" || node.arguments.length !== 0) {
          return null;
        }
        const callee = node.callee;
        if (
          callee?.type !== "ArrowFunctionExpression" &&
          callee?.type !== "FunctionExpression"
        ) {
          return null;
        }
        if (callee.body?.type === "ObjectExpression") {
          return objectSqlFragmentProperties(callee.body);
        }
        return returnedObjectSqlFragmentProperties(callee.body);
      }
      function objectSqlFragmentPropertiesFromExpression(node) {
        return (
          objectSqlFragmentProperties(node) ??
          iifeObjectSqlFragmentProperties(node)
        );
      }
      function guardedSqlIdentifierVariable(node) {
        if (!statementExits(node.consequent)) return null;
        const test = node.test;
        const call =
          test?.type === "UnaryExpression" && test.operator === "!"
            ? test.argument
            : null;
        if (call?.type !== "CallExpression") return null;
        const callee = call.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.type !== "Identifier" ||
          callee.property.name !== "test"
        ) {
          return null;
        }
        if (callee.object?.type !== "Identifier") return null;
        const regexVariable = findVariable(sourceCode, callee.object);
        if (!regexVariable || !sqlIdentifierRegexVariables.has(regexVariable)) {
          return null;
        }
        const arg = call.arguments[0];
        return arg?.type === "Identifier" ? arg : null;
      }
      return {
        Program(node) {
          for (const statement of node.body ?? []) {
            scanSqlEscaperDeclaration(statement);
          }
          for (const statement of node.body ?? []) {
            scanSafeSqlFragmentDeclaration(statement);
          }
        },
        VariableDeclarator(node) {
          markSqlEscaperFunction(node);
          markSafeSqlFragmentFunction(node);
          const variable = getDeclaredVariable(sourceCode, node);
          if (!variable) return;
          if (isSqlIdentifierRegexLiteral(node.init)) {
            sqlIdentifierRegexVariables.add(variable);
          }
          const objectValues = objectLiteralIdentifierValues(node.init);
          const tokenValues = sqlTokenValues(node.init);
          if (objectValues && node.parent?.kind === "const") {
            safeSqlIdentifierObjectValues.set(variable, objectValues);
          }
          if (
            tokenValues &&
            [...tokenValues].every(
              (value) =>
                isSqlIdentifierTokenValue(value) ||
                isSqlDirectionTokenValue(value),
            )
          ) {
            safeSqlIdentifierValues.set(variable, tokenValues);
          }
          if (isSafeSqlIdentifierExpression(node.init)) {
            safeDynamicSqlIdentifierVariables.add(variable);
          }
          if (isSafeSqlFragmentArrayExpression(node.init)) {
            safeSqlFragmentArrays.add(variable);
          } else if (isSafeSqlFragmentExpression(node.init)) {
            safeSqlFragmentStrings.add(variable);
          } else {
            const sqlFragmentObjectProperties =
              objectSqlFragmentPropertiesFromExpression(node.init);
            if (sqlFragmentObjectProperties && node.parent?.kind === "const") {
              safeSqlFragmentObjectValues.set(
                variable,
                sqlFragmentObjectProperties,
              );
            }
          }
        },
        AssignmentExpression(node) {
          const assignedIdentifier = assignedSqlIdentifierNode(node);
          if (!assignedIdentifier) return;
          const variable = findVariable(sourceCode, assignedIdentifier);
          if (!variable) return;
          safeSqlFragmentArrays.delete(variable);
          safeSqlFragmentStrings.delete(variable);
          unmarkSqlIdentifierVariable(variable);
        },
        IfStatement(node) {
          const identifier = guardedSqlIdentifierVariable(node);
          if (identifier) markDynamicSqlIdentifierVariable(identifier);
        },
        "AssignmentExpression:exit"(node) {
          if (node.left?.type !== "MemberExpression") return;
          if (isSafeSqlIdentifierExpression(node.right)) {
            markDynamicSqlIdentifierMember(node.left);
          } else {
            unmarkDynamicSqlIdentifierMember(node.left);
          }
        },
        CallExpression(node) {
          const callee = node.callee;
          if (
            callee?.type !== "MemberExpression" ||
            callee.computed ||
            callee.property?.type !== "Identifier" ||
            callee.property.name !== "push"
          ) {
            return;
          }
          if (callee.object?.type !== "Identifier") return;
          const variable = findVariable(sourceCode, callee.object);
          if (!variable || !safeSqlFragmentArrays.has(variable)) return;
          if (
            !node.arguments.every((arg) => isSafeSqlFragmentExpression(arg))
          ) {
            safeSqlFragmentArrays.delete(variable);
          }
        },
        TemplateLiteral(node) {
          if (
            node.parent?.type === "TaggedTemplateExpression" &&
            node.parent.quasi === node &&
            isParameterizedSqlTag(node.parent.tag)
          ) {
            return;
          }
          if (
            node.expressions.length > 0 &&
            (sqlPattern.test(templateText(node)) ||
              sqlSentencePattern.test(templateText(node)))
          ) {
            if (!hasUnsafeSqlInterpolation(node)) return;
            context.report({
              node,
              message:
                "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
        BinaryExpression(node) {
          if (node.operator !== "+") return;
          const sides = [node.left, node.right];
          const hasSqlLiteral = sides.some(
            (side) =>
              side?.type === "Literal" &&
              typeof side.value === "string" &&
              sqlPattern.test(side.value),
          );
          const hasNonLiteral = sides.some(
            (side) => side && side.type !== "Literal",
          );
          if (hasSqlLiteral && hasNonLiteral) {
            context.report({
              node,
              message:
                "Do not concatenate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
      };
    },
  };
}

function ruleNoUnsafeDeserialize() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow JSON.parse on any/unknown values without validation.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-unsafe-deserialize");
      }
      const checker = services.program.getTypeChecker();

      return {
        CallExpression(node) {
          if (isUnsafeJsonParseInput(node, services, checker)) {
            context.report({
              node,
              message:
                "Do not JSON.parse any/unknown input directly. Validate through a schema boundary instead.",
            });
          }
        },
      };
    },
  };
}

function ruleRequireAuthzCheck() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require an authorization/ownership check when a handler reads request params.",
      },
      schema: [
        {
          type: "object",
          properties: {
            authzFunctions: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const tracker = createAuthBoundaryTracker({
        authzFunctions: context.options[0]?.authzFunctions ?? [
          ...DEFAULT_AUTHZ_FUNCTIONS,
        ],
        onFrameExit(frame) {
          if (frame.paramsAccess && !frame.sawAuthz) {
            context.report({
              node: frame.paramsAccess,
              message:
                "Handler reads request params without an authorization/ownership check. Call requireUser/authorize (boundaries registry).",
            });
          }
        },
      });
      return tracker.visitors;
    },
  };
}

// Local type is a structural fork of a canonical type when every one of its resolved properties
// matches a canonical property by name AND type string (i.e. local ⊆ canonical). This fires on
// exact copies and subsets (drift) but never on supersets like `User & { tenantId }` — a real
// extension has extra properties not present in the canonical type, so it is not a subset.
function isStructuralFork(local, canonical) {
  for (const [name, typeStr] of local) {
    if (canonical.get(name) !== typeStr) return false;
  }
  return true;
}

function sortedProps(props) {
  return [...props.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function structuralCandidateRank(candidate) {
  return candidate.authorityState === "accepted" ? 0 : 1;
}

function sortedStructuralCandidates(candidates) {
  return [...candidates].sort(
    (left, right) =>
      structuralCandidateRank(left) - structuralCandidateRank(right) ||
      left.label.localeCompare(right.label),
  );
}

function structuralMatchProof(sym, local, candidate, diagnostic) {
  const localProps = sortedProps(local);
  return {
    authorityState: candidate.authorityState ?? "proposal",
    diagnostic,
    localType: {
      name: sym.getName(),
      props: localProps,
    },
    ownerType: {
      authority: candidate.authority ?? "unknown",
      label: candidate.label,
      props: sortedProps(candidate.props),
    },
    structuralMatch: {
      matchedProps: localProps.map(([name]) => name),
      relation: "local-subset-of-owner",
      localPropCount: local.size,
      ownerPropCount: candidate.props.size,
    },
  };
}

function emitStructuralMatchFact(context, node, ruleId, proof) {
  return emitSemanticFact(context, node, {
    factKind: "structuralMatch",
    ruleId,
    adapterId: "typescript-eslint/type-owner",
    confidence: proof.diagnostic.emitted
      ? "deterministic-enforcement"
      : "deterministic-inventory",
    provenance: ["AST", "TypeChecker"],
    payload: proof,
  });
}

function structuralDiagnosticFor(candidate, messageId) {
  if (candidate.authorityState === "accepted") {
    return { emitted: true, messageId };
  }
  return {
    emitted: false,
    reason: "owner-authority-unaccepted",
  };
}

function findStructuralProof(sym, local, candidates, messageId) {
  for (const candidate of sortedStructuralCandidates(candidates)) {
    if (isStructuralFork(local, candidate.props)) {
      return structuralMatchProof(
        sym,
        local,
        candidate,
        structuralDiagnosticFor(candidate, messageId),
      );
    }
  }
  return null;
}

function isAllOptionalObjectShape(node) {
  let members = [];
  if (
    node.type === "TSTypeAliasDeclaration" &&
    node.typeAnnotation?.type === "TSTypeLiteral"
  ) {
    members = node.typeAnnotation.members;
  } else if (node.type === "TSInterfaceDeclaration") {
    members = node.body.body;
  }
  const props = members.filter(
    (member) => member.type === "TSPropertySignature",
  );
  return props.length > 0 && props.every((prop) => prop.optional);
}

// Canonical candidate list is cached per TypeScript Program (stable per ESLint process),
// so the node_modules enumeration runs once rather than per linted file.
const canonicalCache = new WeakMap();

function typeReferenceName(typeNode) {
  if (typeNode?.typeName?.type === "Identifier") return typeNode.typeName.name;
  if (typeNode?.typeName?.type === "TSQualifiedName") {
    return typeNode.typeName.right?.name ?? typeNode.typeName.left?.name ?? "";
  }
  return "";
}

function typeReferenceArguments(typeNode) {
  return (
    typeNode?.typeArguments?.params ?? typeNode?.typeParameters?.params ?? []
  );
}

function isDerivationSourceReference(typeNode) {
  return (
    typeNode?.type === "TSTypeReference" || typeNode?.type === "TSImportType"
  );
}

function isStructuralDerivationAlias(node) {
  if (node.type !== "TSTypeAliasDeclaration") return false;
  const annotation = node.typeAnnotation;
  if (annotation?.type === "TSTupleType") return true;
  if (annotation?.type !== "TSTypeReference") return false;
  if (!structuralDerivationUtilities.has(typeReferenceName(annotation))) {
    return false;
  }
  return isDerivationSourceReference(typeReferenceArguments(annotation)[0]);
}

function isTypePredicateReturn(fn) {
  return fn?.returnType?.typeAnnotation?.type === "TSTypePredicate";
}

function ruleNoStructuralTypeFork() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written types structurally equivalent to (or a subset of) an installed package or configured generated source exported type.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            generatedSources: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  generated: { type: "string" },
                },
              },
            },
            packageTypeOwners: {
              type: "object",
              additionalProperties: {
                type: "object",
                required: ["package", "exportName"],
                additionalProperties: false,
                properties: {
                  package: { type: "string" },
                  exportName: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-structural-type-fork");
      }
      const program = services.program;
      const checker = program.getTypeChecker();
      const generatedSources = context.options[0]?.generatedSources ?? {};
      const packageTypeOwners = context.options[0]?.packageTypeOwners ?? {};
      const shouldCollectProposalFacts = Boolean(semanticFactSink(context));

      let candidates = [];
      if (Object.keys(generatedSources).length > 0) {
        candidates = collectGeneratedCanonicalTypes(
          program,
          checker,
          generatedSources,
        );
      }
      if (Object.keys(packageTypeOwners).length > 0) {
        candidates = [
          ...candidates,
          ...collectAcceptedPackageCanonicalTypes(
            program,
            checker,
            packageTypeOwners,
          ),
        ];
      }
      if (shouldCollectProposalFacts) {
        let installedCandidates = canonicalCache.get(program);
        if (!installedCandidates) {
          installedCandidates = collectCanonicalTypes(program, checker);
          canonicalCache.set(program, installedCandidates);
        }
        candidates = [...candidates, ...installedCandidates];
      }
      if (!candidates.length) return {};

      function check(node) {
        if (isAllOptionalObjectShape(node)) return;
        if (isStructuralDerivationAlias(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) return;
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) return;
        // `type AppUser = firebase.User` resolves to the package's own type — a reference, not a
        // fork. Only hand-written shapes (resolved symbol declared in the user's code) are flagged.
        if (resolvesToInstalledType(declared)) return;
        if (resolvesToGeneratedType(declared, generatedSources)) return;
        const local = typeProps(checker, declared);
        if (local.size < MIN_PROPS) return;
        const proof = findStructuralProof(
          sym,
          local,
          candidates,
          "structuralTypeFork",
        );
        if (!proof) return;
        emitStructuralMatchFact(
          context,
          node,
          "antidrift/no-structural-type-fork",
          proof,
        );
        if (proof.diagnostic.emitted) {
          context.report({
            node,
            message: `Type matches ${proof.ownerType.label} — import or derive from the owner instead of redeclaring.`,
          });
        }
      }

      return {
        TSTypeAliasDeclaration: check,
        TSInterfaceDeclaration: check,
      };
    },
  };
}

function ruleNoCanonicalModelFork() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect hand-written copies of configured repo-owned canonical domain models.",
      },
      schema: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            canonicalEntities: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      owner: { type: "string" },
                      exportName: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-canonical-model-fork");
      }
      const program = services.program;
      const checker = program.getTypeChecker();
      const canonicalEntities = context.options[0]?.canonicalEntities ?? {};
      const candidates = collectDomainCanonicalTypes(
        program,
        checker,
        canonicalEntities,
      );
      if (!candidates.length) return {};

      function check(node) {
        if (
          node.type === "TSTypeAliasDeclaration" &&
          node.typeAnnotation?.type !== "TSTypeLiteral"
        ) {
          return;
        }
        if (isAllOptionalObjectShape(node)) return;
        if (isStructuralDerivationAlias(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const sym = tsNode?.name && checker.getSymbolAtLocation(tsNode.name);
        if (!sym) return;
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        if (!isObjectType(declared)) return;
        if (resolvesToDomainCanonicalType(declared, canonicalEntities)) return;
        const local = typeProps(checker, declared);
        if (local.size < MIN_PROPS) return;
        const proof = findStructuralProof(
          sym,
          local,
          candidates,
          "canonicalModelFork",
        );
        if (!proof) return;
        emitStructuralMatchFact(
          context,
          node,
          "antidrift/no-canonical-model-fork",
          proof,
        );
        if (proof.diagnostic.emitted) {
          context.report({
            node,
            message: `Type matches ${proof.ownerType.label} — import or derive from the canonical model owner instead of redeclaring.`,
          });
        }
      }

      return {
        TSTypeAliasDeclaration: check,
        TSInterfaceDeclaration: check,
      };
    },
  };
}

function ruleNoAppeasementCast() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow casting any/unknown values into named object contracts.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-appeasement-cast");
      }
      const checker = services.program.getTypeChecker();

      return {
        TSAsExpression(node) {
          if (!isAppeasementContractCast(node, services, checker)) return;

          context.report({
            node,
            message:
              "Do not cast any/unknown into a named contract. Validate or narrow the value before assigning the type.",
          });
        },
      };
    },
  };
}

function ruleNoNullablePositionalTuple() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow tuple types that model multiple nullable positional slots.",
      },
      schema: [],
    },
    create(context) {
      const services =
        context.sourceCode?.parserServices ?? context.parserServices;
      const checker = services?.program?.getTypeChecker?.();

      return {
        TSTupleType(node) {
          if (!hasNullablePositionalTuple(node, services, checker)) return;
          context.report({
            node,
            message:
              "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
          });
        },
      };
    },
  };
}

function ruleNoUndercheckedTypePredicate() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow broad-input type predicates that assert object contracts without decisive runtime checks.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-underchecked-type-predicate",
        );
      }
      const checker = services.program.getTypeChecker();

      function check(fn) {
        const parts = typePredicateParts(fn);
        if (!parts) return;
        const param = functionParameterByName(fn, parts.paramName);
        const tsParam = param && services.esTreeNodeToTSNodeMap.get(param);
        const tsTargetTypeNode = services.esTreeNodeToTSNodeMap.get(
          parts.targetTypeNode,
        );
        if (!tsParam || !tsTargetTypeNode) return;

        const paramType = checker.getTypeAtLocation(tsParam);
        if (!isBroadPredicateInputType(checker, paramType)) return;

        const targetType = checker.getTypeFromTypeNode(tsTargetTypeNode);
        if (!isPredicateObjectContract(targetType)) return;
        const targetProps = requiredTypeProps(checker, targetType);
        if (targetProps.size < 2) return;
        if (hasValidatorDelegation(fn.body, parts.paramName)) return;

        const checked = checkedTargetProperties(
          fn.body,
          parts.paramName,
          targetProps,
        );
        if (checked.size >= Math.min(2, targetProps.size)) return;

        context.report({
          node: fn.returnType,
          message:
            "Do not narrow broad input with an under-checked type predicate. Check the asserted fields or delegate to an owned schema/validator.",
        });
      }

      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  };
}

function ruleNoDefensiveShapeProbing() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Object.entries normalizers that repeatedly probe broad object shape.",
      },
      schema: [
        {
          type: "object",
          properties: { threshold: { type: "number" } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-defensive-shape-probing",
        );
      }
      const checker = services.program.getTypeChecker();
      const threshold = context.options[0]?.threshold ?? 4;

      return {
        CallExpression(node) {
          const probe = objectEntriesCallbackProbe(node);
          if (!probe || isTypePredicateReturn(probe.callback)) return;
          if (!hasBroadObjectEntriesValue(probe, services, checker)) return;
          if (
            countShapeProbesIn(probe.callback.body, probe.paramNames) <
            threshold
          ) {
            return;
          }
          context.report({
            node: probe.callback,
            message:
              "Do not unpack broad object shapes by probing property names inside Object.entries(...). Move the normalization to an owned schema or converter.",
          });
        },
      };
    },
  };
}

function fileMatchesPath(filename, filePath) {
  return filename.replace(/\\/gu, "/").endsWith(filePath.replace(/\\/gu, "/"));
}

function ruleNoStatusLiteralInType() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow re-declaring canonical domain status values as type literals outside the owning module (domain registry).",
      },
      schema: [
        {
          type: "object",
          properties: { statuses: { type: "object" } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const statuses = context.options[0]?.statuses ?? {};
      if (Object.keys(statuses).length === 0) return {};
      const filename = context.filename ?? context.getFilename();
      return {
        TSLiteralType(node) {
          const owner = canonicalStatusLiteralOwner(node, statuses);
          if (!owner) return;
          if (fileMatchesPath(filename, owner.owner)) return;
          context.report({
            node,
            message: `String literal '${owner.value}' duplicates a canonical status from ${owner.owner}. Import the type instead.`,
          });
        },
      };
    },
  };
}

function ruleNoRedundantZodParse() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Detect re-parsing a value with the same Zod schema that already produced it. Validate once at the boundary and pass the parsed value inward instead of re-validating in every layer.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-redundant-zod-parse");
      }
      const checker = services.program.getTypeChecker();
      // Symbol of a value already validated → symbol of the schema that validated it.
      const validatedBy = new Map();
      const symbolOf = (node) => {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        return tsNode ? checker.getSymbolAtLocation(tsNode) : undefined;
      };
      const callResultSymbols = new Set();
      return {
        VariableDeclarator(node) {
          if (
            node.id.type !== "Identifier" ||
            !isAwaitedCallInitializer(node.init)
          ) {
            return;
          }
          const sym = symbolOf(node.id);
          if (sym) callResultSymbols.add(sym);
        },
        CallExpression(node) {
          const parts = zodParseCallParts(node, services, checker);
          if (!parts) return;
          const { callee, tsCall, arg } = parts;
          const schemaSym =
            callee.object.type === "Identifier"
              ? symbolOf(callee.object)
              : undefined;
          if (isThrowAssertionCallbackParse(node)) return;

          // Re-parse: the argument is a value already validated by this exact schema (same binding).
          if (
            arg.type === "Identifier" &&
            schemaSym &&
            validatedBy.get(symbolOf(arg)) === schemaSym
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this value was already validated by the same schema. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }

          // Service-to-boundary re-parse: a called helper/service already returned the schema's
          // output type, and the caller immediately validates that typed contract again.
          if (
            arg.type === "Identifier" &&
            callResultSymbols.has(symbolOf(arg)) &&
            parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg)
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this call result is already typed as the schema output. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }

          if (
            isCallResultExpression(arg) &&
            !isZodParseExpression(arg, services, checker) &&
            parsedCallResultMatchesSchemaOutput(checker, services, tsCall, arg)
          ) {
            context.report({
              node,
              message:
                "Redundant Zod parse: this call result is already typed as the schema output. Validate once at the boundary and pass the parsed value inward instead of re-parsing.",
            });
            return;
          }

          // Provenance: record `const v = Schema.parse(...)` / `const v = await Schema.parseAsync(...)`.
          recordParsedConst(node, schemaSym, symbolOf, validatedBy);
        },
      };
    },
  };
}

const rules = {
  "no-trivial-selector-wrapper": ruleNoTrivialSelectorWrapper(),
  "no-inline-structural-type-at-use-site":
    ruleNoInlineStructuralTypeAtUseSite(),
  "no-appeasement-cast": ruleNoAppeasementCast(),
  "no-nullable-positional-tuple": ruleNoNullablePositionalTuple(),
  "no-underchecked-type-predicate": ruleNoUndercheckedTypePredicate(),
  "no-defensive-shape-probing": ruleNoDefensiveShapeProbing(),
  "no-handrolled-resource-lifecycle-cells": ruleNoHandrolledResourceLifecycleCells(),
  "no-shattered-ingested-entity-state": ruleNoShatteredIngestedEntityState(),
  "require-effect-deps": ruleRequireEffectDeps(),
  "no-raw-tailwind-color": ruleClassNamePattern(
    "no-raw-tailwind-color",
    rawTailwindColorPattern,
    "Use semantic design tokens instead of raw Tailwind color utilities.",
  ),
  "no-hover-translate-card": ruleClassNamePattern(
    "no-hover-translate-card",
    hoverTranslatePattern,
    "Do not move pointer targets on hover. Use shadow, border, color, or inner transforms.",
  ),
  "no-raw-fetch-in-component": ruleNoRawFetchInComponent(),
  "no-async-array-method": ruleNoAsyncArrayMethod(),
  "no-sql-string-concat": ruleNoSqlStringConcat(),
  "no-unsafe-deserialize": ruleNoUnsafeDeserialize(),
  "require-authz-check": ruleRequireAuthzCheck(),
  "no-structural-type-fork": ruleNoStructuralTypeFork(),
  "no-canonical-model-fork": ruleNoCanonicalModelFork(),
  "no-redundant-zod-parse": ruleNoRedundantZodParse(),
  "no-status-literal-in-type": ruleNoStatusLiteralInType(),
};

export default {
  meta: { name: "@joedeleeuw/antidrift/eslint-plugin", version: "0.2.0" },
  rules,
};
