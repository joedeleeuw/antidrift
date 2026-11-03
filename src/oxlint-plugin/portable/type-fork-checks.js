import { singleReturnExpression } from "./type-predicate-checks.js";
import { getProgramIndex } from "../shared/program-index.js";
import {
  isObjectSchemaMethod,
  isSchemaLiteralCall,
  isSchemaObjectOrExtendCall,
  isSchemaUnionCall,
  objectSchemaTagPairs,
  resolveSchemaBuilderCall,
  schemaDiscriminantKeys,
  unionDiscriminantPairs,
} from "../shared/runtime-schema-libraries.js";
import {
  constInitializer,
  findVariable,
  isFunctionLike,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";

const HOLE = "<hole>";
const PROPERTY_KEY_PARENTS = new Set([
  "Property",
  "PropertyDefinition",
  "MethodDefinition",
  "TSPropertySignature",
  "TSMethodSignature",
]);

function isPropertyName(node) {
  const parent = node.parent;
  if (parent?.computed || parent?.shorthand) return false;
  return (
    (parent?.type === "MemberExpression" && parent.property === node) ||
    (PROPERTY_KEY_PARENTS.has(parent?.type) && parent.key === node)
  );
}

function residual(node, holes, referenceKey, sourceCode) {
  if (!node || typeof node.type !== "string") return String(node ?? "");
  if (holes(node)) return HOLE;
  if (node.type === "Identifier") {
    return isPropertyName(node) ? node.name : referenceKey(node);
  }
  if (node.type === "Literal") {
    return typeof node.value === "string"
      ? JSON.stringify(node.value)
      : String(node.raw);
  }
  const parts = (sourceCode.visitorKeys[node.type] ?? []).map((key) =>
    [node[key]]
      .flat()
      .map((child) => residual(child, holes, referenceKey, sourceCode))
      .join(",")
  );
  const flags = `${node.operator ?? ""}${node.optional ? "?" : ""}`;
  return `${node.type}${flags}(${parts.join(";")})`;
}

function localFunction(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  const candidate =
    definition?.type === "FunctionName"
      ? definition.node
      : constInitializer(sourceCode, identifier);
  return isFunctionLike(candidate) ? candidate : null;
}

function schemaBranchRoot(branch, sourceCode) {
  const expression = unwrapExpression(branch);
  if (expression?.type === "Identifier") {
    const owner = findVariable(sourceCode, expression)?.defs?.[0]?.node;
    return { root: constInitializer(sourceCode, expression), owner };
  }
  const callee = unwrapExpression(expression?.callee);
  const factory =
    callee?.type === "Identifier" ? localFunction(callee, sourceCode) : null;
  if (
    factory?.params.length === 1 &&
    factory.params[0].type === "Identifier" &&
    expression.arguments.length === 1 &&
    expression.arguments[0].type === "Literal"
  ) {
    const parameter = findVariable(sourceCode, factory.params[0]);
    return { root: singleReturnExpression(factory.body), factory, parameter };
  }
  return { root: expression };
}

function resolveSchemaBranch(branch, sourceCode) {
  const resolved = schemaBranchRoot(branch, sourceCode);
  const objectCall = isSchemaObjectOrExtendCall(resolved.root, sourceCode);
  return objectCall
    ? { ...resolved, members: objectCall.shapeNode.properties }
    : null;
}

const MEMBER_LISTS = {
  TSTypeLiteral: (root) => root.members,
  TSInterfaceBody: (root) => root.body,
};

function resolveTypeBranch(branch, typeDeclarations) {
  const declaration =
    branch.type === "TSTypeReference" && !branch.typeArguments
      ? typeDeclarations.get(branch.typeName?.name)
      : null;
  const root =
    branch.type === "TSTypeLiteral"
      ? branch
      : (declaration?.body ?? declaration?.typeAnnotation);
  const members =
    !declaration?.extends?.length && MEMBER_LISTS[root?.type]?.(root);
  return members ? { root, members, owner: declaration } : null;
}

function memberValidator(member) {
  return member.type === "TSPropertySignature"
    ? member.typeAnnotation?.typeAnnotation
    : member.value;
}

function unionBranches(node, sourceCode, typeDeclarations) {
  const union =
    node.type === "TSUnionType"
      ? { discriminantKey: null, branches: node.types }
      : isSchemaUnionCall(node, sourceCode);
  const resolve =
    node.type === "TSUnionType"
      ? (branch) => resolveTypeBranch(branch, typeDeclarations)
      : (branch) => resolveSchemaBranch(branch, sourceCode);
  return {
    discriminantKey: union?.discriminantKey ?? null,
    branches: (union?.branches ?? []).map(resolve).filter(Boolean),
  };
}

function isLiteralValidator(validator, sourceCode) {
  return (
    validator?.type === "TSLiteralType" ||
    isSchemaLiteralCall(validator, sourceCode) !== null
  );
}

function sharedDiscriminantKey(branches, declaredKey, sourceCode) {
  const candidates = declaredKey ? [declaredKey] : [...schemaDiscriminantKeys];
  return (
    candidates.find((key) =>
      branches.every((branch) =>
        branch.members.some(
          (member) =>
            staticPropertyKey(member) === key &&
            (Boolean(branch.parameter) ||
              isLiteralValidator(memberValidator(member), sourceCode))
        )
      )
    ) ?? null
  );
}

function branchResidual(branch, discriminantKey, sourceCode) {
  const holeNodes = new Set(
    branch.members
      .filter((member) => staticPropertyKey(member) === discriminantKey)
      .map(memberValidator)
  );
  const referenceKey = (identifier) =>
    branch.parameter &&
    findVariable(sourceCode, identifier) === branch.parameter
      ? HOLE
      : identifier.name;
  return residual(
    branch.root,
    (candidate) => holeNodes.has(candidate),
    referenceKey,
    sourceCode
  );
}

function degenerateGroup(branches, discriminantKey, sourceCode) {
  const groups = new Map();
  for (const branch of branches) {
    const payloadSize = branch.members.length - 1;
    if (payloadSize < (branch.root.type.startsWith("TS") ? 2 : 1)) continue;
    const key = branchResidual(branch, discriminantKey, sourceCode);
    groups.set(key, [...(groups.get(key) ?? []), branch]);
  }
  return [...groups.values()].find((group) => group.length >= 2) ?? null;
}

function repeatedFieldSignatures(branches, sourceCode) {
  const counts = new Map();
  for (const branch of branches) {
    const signatures = new Set(
      branch.members.flatMap((member) => {
        const key = staticPropertyKey(member);
        const validator = memberValidator(member);
        return key &&
          validator &&
          !schemaDiscriminantKeys.has(key) &&
          !isLiteralValidator(validator, sourceCode)
          ? [
              `${key}${member.optional ? "?" : ""}: ${sourceCode.getText(validator)}`,
            ]
          : [];
      })
    );
    for (const signature of signatures) {
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, count]) => count >= 3).map(([text]) => text);
}

function exportedName(owner) {
  const declaration =
    owner?.type === "VariableDeclarator" ? owner.parent : owner;
  return declaration?.parent?.type === "ExportNamedDeclaration" &&
    owner.id?.type === "Identifier"
    ? owner.id.name
    : null;
}

function reportExportedBranches(group, rootName, context) {
  const owners = new Set(
    group.map((branch) =>
      branch.factory && branch.factory.type !== "FunctionDeclaration"
        ? branch.factory.parent
        : (branch.owner ?? branch.factory)
    )
  );
  for (const owner of owners) {
    const name = exportedName(owner);
    if (!name) continue;
    context.report({
      node: owner.id,
      message: `Exported '${name}' restates a variant of exported union root '${rootName}'; export only the root and narrow it where a single variant is needed.`,
    });
  }
}

export function checkUnionOwnership(node, context, typeDeclarations) {
  const sourceCode = context.sourceCode;
  const union = unionBranches(node, sourceCode, typeDeclarations);
  const branches = union.branches;
  if (branches.length < 2) return;
  const discriminantKey = sharedDiscriminantKey(
    branches,
    union.discriminantKey,
    sourceCode
  );
  const group =
    discriminantKey && degenerateGroup(branches, discriminantKey, sourceCode);
  if (group) {
    context.report({
      node,
      message: `${group.length} union branches differ only in their '${discriminantKey}' discriminator; declare one shape whose '${discriminantKey}' is the literal union instead of restating each branch.`,
    });
    const rootName = exportedName(node.parent);
    if (rootName) reportExportedBranches(group, rootName, context);
    return;
  }
  const objectBranches = branches.filter((branch) => !branch.factory);
  if (objectBranches.length < 3) return;
  const repeated = repeatedFieldSignatures(objectBranches, sourceCode);
  if (repeated.length >= 2) {
    context.report({
      node,
      message: `Union branches each restate the fields ${repeated.map((text) => `'${text}'`).join(", ")}; factor them into one shared base and extend it per variant.`,
    });
  }
}

function caseReturn(switchCase) {
  const [first] = switchCase.consequent;
  const statements =
    switchCase.consequent.length === 1 && first.type === "BlockStatement"
      ? first.body
      : switchCase.consequent;
  return statements.length === 1 && statements[0].type === "ReturnStatement"
    ? statements[0].argument
    : null;
}

export function checkIdentitySwitch(node, context) {
  const sourceCode = context.sourceCode;
  const discriminant = unwrapExpression(node.discriminant);
  if (
    discriminant?.type !== "MemberExpression" ||
    discriminant.computed ||
    !schemaDiscriminantKeys.has(discriminant.property?.name)
  ) {
    return;
  }
  const discriminantText = sourceCode.getText(discriminant);
  const counts = new Map();
  for (const switchCase of node.cases) {
    const returned = caseReturn(switchCase);
    if (switchCase.test?.type !== "Literal" || !returned) continue;
    const holes = (candidate) =>
      (candidate.type === "Literal" &&
        candidate.value === switchCase.test.value) ||
      (candidate.type === "MemberExpression" &&
        sourceCode.getText(candidate) === discriminantText);
    const key = residual(returned, holes, (id) => id.name, sourceCode);
    if (key.includes(HOLE)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const largest = Math.max(0, ...counts.values());
  if (largest >= 2) {
    context.report({
      node,
      message: `Switch on '${discriminantText}' has ${largest} arms that differ only by the case value; return the shared expression once using '${discriminantText}' instead of restating each arm.`,
    });
  }
}

export function checkSchemaExports(program, context) {
  const sourceCode = context.sourceCode;
  const bindings = program.body.flatMap((stmt) => {
    const decl =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    return decl?.type === "VariableDeclaration" ? decl.declarations : [];
  });
  const memberDeclarators = new Set();
  const unionPairs = new Set(
    bindings.flatMap((binding) =>
      unionDiscriminantPairs(binding.init, sourceCode, memberDeclarators)
    )
  );
  for (const binding of bindings) {
    const builder = resolveSchemaBuilderCall(
      unwrapExpression(binding.init),
      sourceCode
    );
    const hit =
      !memberDeclarators.has(binding) &&
      exportedName(binding) &&
      binding.parent.kind === "const" &&
      isObjectSchemaMethod(builder?.method) &&
      objectSchemaTagPairs(binding.init, sourceCode).find((entry) =>
        unionPairs.has(entry.pair)
      );
    if (hit) {
      context.report({
        node: binding.id,
        message: `Exported variant schema duplicates the '${hit.key}' discriminant of a union in this module; derive variants from the canonical union instead of exporting parallel object schemas.`,
      });
    }
  }
}

const SEAM_SUFFIX =
  /(?:Port|Adapter|Gateway|Repository|Strategy|Provider|Transport)$/u;
const EFFECTFUL_DEFAULTS = new Set([
  "Date.now()",
  "new Date()",
  "Math.random()",
  "crypto.randomUUID()",
  "performance.now()",
]);

function reportSingleAdapterSeams(context, seams, implementCounts) {
  const index = getProgramIndex(context.sourceCode);
  for (const [name, seam] of seams) {
    if (seam.exported && !index) continue;
    const total = seam.exported
      ? (index.implementedSeams.get(name)?.size ?? 0)
      : implementCounts.get(name);
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

function reportTestOnlySeams(context, defaults) {
  const sourceCode = context.sourceCode;
  const index = getProgramIndex(sourceCode);
  for (const parameter of defaults) {
    const fnNode = parameter.parent;
    const nameNode =
      fnNode.type === "FunctionDeclaration" ? fnNode.id : fnNode.parent?.id;
    if (nameNode?.type !== "Identifier") continue;
    const arity =
      index?.callStats.get(nameNode.name)?.maxArgsNonTest ??
      localCallArity(fnNode, nameNode, sourceCode);
    if (arity === null || arity > fnNode.params.indexOf(parameter)) continue;
    const defaultText = sourceCode.getText(parameter.right);
    context.report({
      node: parameter,
      message: `'${sourceCode.getText(parameter.left)}' defaults to '${defaultText}' and no production caller supplies another value; call '${defaultText}' directly and delete the parameter.`,
    });
  }
}

function seamDeclaration(node) {
  const exported = node.parent?.type === "ExportNamedDeclaration";
  const name = node.id?.name ?? "";
  if (node.type === "ClassDeclaration") {
    return node.abstract && SEAM_SUFFIX.test(name)
      ? { node, exported, kind: "Abstract class" }
      : null;
  }
  return name &&
    (!exported || SEAM_SUFFIX.test(name)) &&
    node.body?.body?.some((member) => member.type === "TSMethodSignature")
    ? { node, exported, kind: "Interface" }
    : null;
}

function implementedSeamNames(node) {
  if (node.type === "VariableDeclarator") {
    const annotation = node.id?.typeAnnotation?.typeAnnotation;
    return annotation?.type === "TSTypeReference" &&
      annotation.typeName?.type === "Identifier" &&
      unwrapExpression(node.init)?.type === "ObjectExpression"
      ? [annotation.typeName.name]
      : [];
  }
  return [
    ...(node.implements ?? []).map((impl) => impl.expression),
    node.superClass,
  ]
    .filter((target) => target?.type === "Identifier")
    .map((target) => target.name);
}

export function createSeamVisitors(context) {
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
    ClassDeclaration(node) {
      recordImplementations(node);
      recordSeam(node);
    },
    VariableDeclarator: recordImplementations,
    AssignmentPattern(node) {
      if (
        isFunctionLike(node.parent) &&
        EFFECTFUL_DEFAULTS.has(context.sourceCode.getText(node.right))
      ) {
        defaults.push(node);
      }
    },
    "Program:exit"() {
      reportSingleAdapterSeams(context, seams, implementCounts);
      reportTestOnlySeams(context, defaults);
    },
  };
}
