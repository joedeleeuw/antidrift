import { getProgramIndex } from "../shared/program-index.js";
import { resolveSymbolKey } from "../shared/implemented-seams.js";
import {
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  isTestFile,
  unwrapExpression,
} from "../shared/scope.js";
import { getTypeServices } from "../shared/type-services.js";

const SCOPE_SCHEMA = [
  { type: "object", properties: scopeProperties, additionalProperties: false },
];

const SEAM_SUFFIX =
  /(?:Port|Ports|Adapter|Gateway|Repository|Strategy|Provider|Transport|Service|Store|Sender|Reporter|Runner|Reader|Writer|Verifier|Connector|Clock|Probe)$/u;
const NON_SEAM_SUFFIX =
  /(?:Props|Options|Context|State|Config|Handlers|Callbacks|Events)$/u;
const EFFECTFUL_DEFAULTS = new Set([
  "Date.now()",
  "new Date()",
  "Math.random()",
  "crypto.randomUUID()",
  "performance.now()",
]);

function reportSingleAdapterSeams(context, seams, implementCounts) {
  const sourceCode = context.sourceCode;
  const index = getProgramIndex(sourceCode);
  const services = getTypeServices(sourceCode);
  for (const [name, seam] of seams) {
    if (seam.exported && !index) continue;
    const symKey = services
      ? resolveSymbolKey(
          services.checker,
          services.nodeMap.get(seam.node.id ?? seam.node)
        )
      : null;
    const symSet = symKey ? index?.implementedSeams.get(symKey) : null;
    const nameSet = index?.implementedSeams.get(name);
    const mergedCount = new Set([...(symSet ?? []), ...(nameSet ?? [])]).size;
    const total = seam.exported
      ? Math.max(mergedCount, implementCounts.get(name) ?? 0)
      : (implementCounts.get(name) ?? 0);
    if (total !== 1) continue;
    context.report({
      node: seam.node.id,
      message: `${seam.kind} '${name}' has only one implementation in this ${seam.exported ? "program" : "module"}; delete the hypothetical seam until a second adapter exists.`,
    });
  }
}

function localCallArity(fnNode, nameNode, sourceCode) {
  const declaration =
    fnNode.type === "FunctionDeclaration" ? fnNode : fnNode.parent?.parent;
  if (declaration?.parent?.type === "ExportNamedDeclaration") return null;
  const references = (
    findVariable(sourceCode, nameNode)?.references ?? []
  ).filter((ref) => ref.identifier !== nameNode);
  const calls = references
    .map((ref) => ref.identifier.parent)
    .filter((call) => call?.type === "CallExpression");
  return calls.length > 0 && calls.length === references.length
    ? Math.max(...calls.map((call) => call.arguments.length))
    : null;
}

function isUnoverriddenDefault(
  parameter,
  fnNode,
  stats,
  localArity,
  isEffectful
) {
  const paramIndex = fnNode.params.indexOf(parameter);
  if (paramIndex < 0) return false;
  const defaultNode = unwrapExpression(parameter.right);
  const isSimpleLiteral =
    defaultNode?.type === "Literal" ||
    (defaultNode?.type === "ObjectExpression" &&
      defaultNode.properties.length === 0) ||
    (defaultNode?.type === "ArrayExpression" &&
      defaultNode.elements.length === 0);
  if (!isEffectful && isSimpleLiteral) return false;
  if (
    !isSimpleLiteral &&
    stats &&
    stats.nonTestCalls > 0 &&
    stats.maxArgsTest > paramIndex &&
    stats.maxArgsNonTest <= paramIndex
  ) {
    return true;
  }
  if (!isEffectful) return false;
  const arity = stats?.maxArgsNonTest ?? localArity;
  return arity !== null && arity <= paramIndex;
}

function reportTestOnlySeams(context, defaults) {
  const sourceCode = context.sourceCode;
  const index = getProgramIndex(sourceCode);
  const services = getTypeServices(sourceCode);
  for (const parameter of defaults) {
    const fnNode = parameter.parent;
    const nameNode =
      fnNode.type === "FunctionDeclaration" ? fnNode.id : fnNode.parent?.id;
    if (nameNode?.type !== "Identifier") continue;
    const defaultText = sourceCode.getText(parameter.right);
    const isEffectful = EFFECTFUL_DEFAULTS.has(defaultText);
    const symKey = services
      ? resolveSymbolKey(services.checker, services.nodeMap.get(nameNode))
      : null;
    const stats =
      (symKey && index?.callStats.get(symKey)) ??
      index?.callStats.get(nameNode.name);
    const localArity = localCallArity(fnNode, nameNode, sourceCode);
    if (
      !isUnoverriddenDefault(parameter, fnNode, stats, localArity, isEffectful)
    ) {
      continue;
    }
    context.report({
      node: parameter,
      message: `'${sourceCode.getText(parameter.left)}' defaults to '${defaultText}' and no production caller supplies another value; call '${defaultText}' directly and delete the parameter.`,
    });
  }
}

function hasBehavioralMember(members) {
  return (members ?? []).some(
    (member) =>
      member.type === "TSMethodSignature" ||
      (member.type === "TSPropertySignature" &&
        !member.optional &&
        member.typeAnnotation?.typeAnnotation?.type === "TSFunctionType")
  );
}

function seamDeclaration(node) {
  const exported = node.parent?.type === "ExportNamedDeclaration";
  const name = node.id?.name ?? "";
  if (!name || NON_SEAM_SUFFIX.test(name)) return null;
  if (node.type === "ClassDeclaration") {
    return node.abstract && SEAM_SUFFIX.test(name)
      ? { node, exported, kind: "Abstract class" }
      : null;
  }
  if (node.type === "TSTypeAliasDeclaration") {
    return SEAM_SUFFIX.test(name) &&
      node.typeAnnotation?.type === "TSTypeLiteral" &&
      hasBehavioralMember(node.typeAnnotation.members)
      ? { node, exported, kind: "Type" }
      : null;
  }
  return SEAM_SUFFIX.test(name) && hasBehavioralMember(node.body?.body)
    ? { node, exported, kind: "Interface" }
    : null;
}

function unwrappedTypeAnnotationName(annotation) {
  if (annotation?.type !== "TSTypeReference") return null;
  if (
    annotation.typeName?.type === "Identifier" &&
    annotation.typeName.name === "Promise"
  ) {
    const inner = annotation.typeArguments?.params?.[0];
    return inner?.type === "TSTypeReference" &&
      inner.typeName?.type === "Identifier"
      ? inner.typeName.name
      : null;
  }
  return annotation.typeName?.type === "Identifier"
    ? annotation.typeName.name
    : null;
}

function implementedSeamNames(node) {
  if (node.type === "VariableDeclarator") {
    const varName = unwrappedTypeAnnotationName(
      node.id?.typeAnnotation?.typeAnnotation
    );
    return varName && unwrapExpression(node.init)?.type === "ObjectExpression"
      ? [varName]
      : [];
  }
  if (isFunctionLike(node)) {
    const retName = unwrappedTypeAnnotationName(
      node.returnType?.typeAnnotation
    );
    return retName ? [retName] : [];
  }
  if (node.type === "TSSatisfiesExpression") {
    const satName = unwrappedTypeAnnotationName(node.typeAnnotation);
    return satName &&
      unwrapExpression(node.expression)?.type === "ObjectExpression"
      ? [satName]
      : [];
  }
  return [
    ...(node.implements ?? []).map((impl) => impl.expression),
    node.superClass,
  ]
    .filter((target) => target?.type === "Identifier")
    .map((target) => target.name);
}

function createSeamVisitors(context) {
  if (isTestFile((context.filename ?? "").replaceAll("\\", "/"))) return {};
  const seams = new Map();
  const implementCounts = new Map();
  const defaults = [];
  const recordSeam = (node) => {
    const seam = seamDeclaration(node);
    if (seam) seams.set(seam.node.id.name, seam);
  };
  const recordImplementations = (node) => {
    for (const name of implementedSeamNames(node)) {
      implementCounts.set(name, (implementCounts.get(name) ?? 0) + 1);
    }
  };
  return {
    TSInterfaceDeclaration: recordSeam,
    TSTypeAliasDeclaration: recordSeam,
    ClassDeclaration(node) {
      recordImplementations(node);
      recordSeam(node);
    },
    VariableDeclarator: recordImplementations,
    FunctionDeclaration: recordImplementations,
    FunctionExpression: recordImplementations,
    ArrowFunctionExpression: recordImplementations,
    TSSatisfiesExpression: recordImplementations,
    AssignmentPattern(node) {
      if (isFunctionLike(node.parent) && node.parent.params?.includes(node)) {
        defaults.push(node);
      }
    },
    "Program:exit"() {
      reportSingleAdapterSeams(context, seams, implementCounts);
      reportTestOnlySeams(context, defaults);
    },
  };
}

export const noHypotheticalSeamRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow single-implementation interfaces and abstract seams, and effectful default parameters that no production caller overrides.",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    return isRuleFile(context) ? createSeamVisitors(context) : {};
  },
};

const AMBIENT_RUNTIME_GLOBALS = new Set(["process", "Buffer", "NodeJS"]);

function checkAmbientRedeclaration(node, context) {
  if (node.declare !== true || /\.d\.[cm]?ts$/u.test(ruleFilename(context))) {
    return;
  }
  const targets =
    node.type === "VariableDeclaration"
      ? node.declarations.map((declarator) => [declarator, declarator.id])
      : [[node, node.id]];
  for (const [reportNode, id] of targets) {
    if (id?.type === "Identifier" && AMBIENT_RUNTIME_GLOBALS.has(id.name)) {
      context.report({
        node: reportNode,
        message: `Do not redeclare ambient '${id.name}' types inline; import the typed environment owner or install the runtime types.`,
      });
    }
  }
}

function reportImportSuppressions(context, importLines) {
  for (const comment of context.sourceCode.getAllComments?.() ?? []) {
    const endLine = comment.loc?.end?.line;
    if (
      /@ts-(?:expect-error|ignore)/u.test(comment.value) &&
      (importLines.has(endLine) || importLines.has(endLine + 1))
    ) {
      context.report({
        loc: comment.loc,
        message:
          "Do not suppress unresolved module or type imports with `@ts-expect-error` or `@ts-ignore`; declare or install the dependency types.",
      });
    }
  }
}

export const noUnresolvedDependencyTypesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `@ts-expect-error`/`@ts-ignore` import suppressions and inline ambient redeclarations of runtime globals (`process`, `Buffer`, `NodeJS`).",
    },
    schema: SCOPE_SCHEMA,
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const importLines = new Set();
    const markImportNode = (node) => importLines.add(node.loc?.start?.line);
    const checkAmbient = (node) => checkAmbientRedeclaration(node, context);
    return {
      VariableDeclaration: checkAmbient,
      TSModuleDeclaration: checkAmbient,
      ImportDeclaration: markImportNode,
      ExportAllDeclaration: markImportNode,
      ExportNamedDeclaration(node) {
        if (node.source) markImportNode(node);
      },
      TSImportType: markImportNode,
      "Program:exit"() {
        reportImportSuppressions(context, importLines);
      },
    };
  },
};
