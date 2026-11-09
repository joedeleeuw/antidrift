import {
  repeatedBranchFields,
  resolvedRepeatedFields,
} from "./union-contracts.js";
import {
  astLiteralText,
  exportedArraysFromProgram,
  importedArrays,
  memberSet,
} from "../shared/owned-union-source.js";
import { isRuleFile } from "../shared/rule-scope.js";
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
  canonicalStatusLiteralOwner,
  constInitializer,
  findVariable,
  isFunctionLike,
  singleReturnExpression,
  staticPropertyKey,
  unwrapExpression,
} from "../shared/scope.js";
import { hasTypeChecker } from "../shared/type-services.js";

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
  const members = MEMBER_LISTS[root?.type]?.(root);
  return members
    ? {
        root,
        members,
        owner: declaration,
        hasExtends: Boolean(declaration?.extends?.length),
      }
    : null;
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
  const plainBranches = branches.filter((branch) => !branch.hasExtends);
  const allTagOnly =
    plainBranches.length >= 2 &&
    plainBranches.every((branch) => branch.members.length === 1);
  if (allTagOnly) return plainBranches;
  const groups = new Map();
  for (const branch of plainBranches) {
    const payloadSize = branch.members.length - 1;
    if (payloadSize < (branch.root.type.startsWith("TS") ? 2 : 1)) continue;
    const key = branchResidual(branch, discriminantKey, sourceCode);
    groups.set(key, [...(groups.get(key) ?? []), branch]);
  }
  return [...groups.values()].find((group) => group.length >= 2) ?? null;
}

function repeatedFieldSignatures(branches, sourceCode) {
  return repeatedBranchFields(
    branches.map((branch) =>
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
    )
  );
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

export function checkUnionOwnership(node, context, state) {
  const sourceCode = context.sourceCode;
  const typeDeclarations = state?.typeDeclarations ?? new Map();
  const union = unionBranches(node, sourceCode, typeDeclarations);
  const branches = union.branches;
  const resolvedFields = resolvedRepeatedFields(node, sourceCode);
  if (branches.length < 2 && resolvedFields === null) return;
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
  const canCheckRepeated =
    objectBranches.length >= 3 ||
    (objectBranches.length === 2 &&
      (node.type !== "TSUnionType" ||
        objectBranches.length === node.types.length));
  const repeated =
    resolvedFields ??
    (canCheckRepeated
      ? repeatedFieldSignatures(objectBranches, sourceCode)
      : []);
  if (repeated.length >= 2) {
    const isNamedOwner =
      node.parent?.type === "TSTypeAliasDeclaration" ||
      node.parent?.type === "VariableDeclarator";
    if (!isNamedOwner) {
      const dedupeKey = `${sourceCode.getText(node).replaceAll(/\s+/gu, " ")}::${repeated.join(",")}`;
      if (state?.seenRepeatedUnions?.has(dedupeKey)) return;
      state?.seenRepeatedUnions?.add(dedupeKey);
    }
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

function fileMatchesPath(filename, filePath) {
  return filename
    .replaceAll("\\", "/")
    .endsWith(filePath.replaceAll("\\", "/"));
}

function convexMethod(node, method, sourceCode) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed
  ) {
    return null;
  }
  const { object, property } = node.callee;
  if (object.type !== "Identifier" || property.name !== method) return null;
  const binding = findVariable(sourceCode, object);
  const definition = binding?.defs[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.node.type !== "ImportSpecifier"
  ) {
    return null;
  }
  const declaration = definition.parent;
  if (
    declaration.source.value !== "convex/values" ||
    declaration.importKind === "type" ||
    definition.node.importKind === "type"
  ) {
    return null;
  }
  return definition.node.imported.name === "v" ? binding : null;
}

export function runtimeValidatorLiteralList(node, sourceCode) {
  const receiver = convexMethod(node, "union", sourceCode);
  if (receiver && node.arguments.length >= 2) {
    const tokens = node.arguments.map((argument) =>
      convexMethod(argument, "literal", sourceCode) === receiver &&
      argument.arguments.length === 1
        ? astLiteralText(argument.arguments[0])
        : null
    );
    return tokens.every(Boolean) ? tokens : null;
  }
  const builder = resolveSchemaBuilderCall(node, sourceCode);
  if (!builder) return null;
  if (
    (builder.method === "enum" || builder.method === "picklist") &&
    builder.args[0]?.type === "ArrayExpression" &&
    builder.args[0].elements.length >= 2
  ) {
    const tokens = builder.args[0].elements.map(astLiteralText);
    return tokens.every(Boolean) ? tokens : null;
  }
  if (builder.method === "Literal" && builder.args.length >= 2) {
    const tokens = builder.args.map(astLiteralText);
    return tokens.every(Boolean) ? tokens : null;
  }
  const unionCall = isSchemaUnionCall(node, sourceCode);
  if (
    unionCall &&
    !unionCall.discriminantKey &&
    unionCall.branches.length >= 2
  ) {
    const tokens = unionCall.branches.map((branch) => {
      const lit = isSchemaLiteralCall(branch, sourceCode);
      return lit ? astLiteralText(lit.argNode) : null;
    });
    return tokens.every(Boolean) ? tokens : null;
  }
  return null;
}

function validatorMembers(node, sourceCode) {
  const tokens = runtimeValidatorLiteralList(node, sourceCode);
  return tokens ? memberSet(tokens) : null;
}

function callSite(node) {
  const segments = [];
  let current = node;
  while (current.parent) {
    current = current.parent;
    if (
      (current.type === "Property" ||
        current.type === "TSPropertySignature" ||
        current.type === "PropertyDefinition") &&
      !current.computed
    ) {
      segments.unshift(current.key.name ?? current.key.value);
    }
    if (
      (current.type === "VariableDeclarator" ||
        current.type === "TSInterfaceDeclaration" ||
        current.type === "TSTypeAliasDeclaration") &&
      current.id?.type === "Identifier"
    ) {
      segments.unshift(current.id.name);
      return segments.join(".");
    }
    if (
      [
        "FunctionDeclaration",
        "ArrowFunctionExpression",
        "FunctionExpression",
      ].includes(current.type)
    ) {
      break;
    }
  }
  return segments.length > 0 ? segments.join(".") : null;
}

function scopeVariable(sourceCode, node, name) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    if (scope.set.has(name)) return scope.set.get(name);
    scope = scope.upper;
  }
  return null;
}

function localOwnerVariable(program, sourceCode, name) {
  for (const statement of program.body) {
    const declaration = statement.declaration ?? statement;
    if (declaration.type !== "VariableDeclaration") continue;
    const owner = declaration.declarations.find(
      (entry) => entry.id.type === "Identifier" && entry.id.name === name
    );
    if (owner) return findVariable(sourceCode, owner.id);
  }
  return null;
}

function importOwners(statement, context, cache) {
  if (statement.importKind === "type") return [];
  const arrays = importedArrays(
    context.filename,
    statement.source.value,
    cache
  );
  return statement.specifiers.flatMap((specifier) => {
    if (specifier.importKind === "type") return [];
    const binding = findVariable(context.sourceCode, specifier.local);
    if (specifier.type === "ImportNamespaceSpecifier") {
      return arrays
        .filter((array) => array.name !== "default")
        .map((array) => ({
          ...array,
          name: `${specifier.local.name}.${array.name}`,
          binding: specifier.local.name,
          variable: binding,
        }));
    }
    const imported =
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : (specifier.imported.name ?? specifier.imported.value);
    return arrays
      .filter((array) => array.name === imported)
      .map((array) => ({
        ...array,
        name: specifier.local.name,
        binding: specifier.local.name,
        variable: binding,
      }));
  });
}

function collectProgramOwners(programNode, context) {
  const owners = exportedArraysFromProgram(programNode).map((array) => ({
    ...array,
    name: array.local,
    binding: array.local,
    variable: localOwnerVariable(programNode, context.sourceCode, array.local),
  }));
  if (hasTypeChecker(context.sourceCode)) return owners;
  const cache = new Map();
  for (const statement of programNode.body) {
    if (statement.type === "ImportDeclaration") {
      owners.push(...importOwners(statement, context, cache));
    }
  }
  return owners;
}

function reportStatusLiteral(node, statuses, context) {
  const owner = canonicalStatusLiteralOwner(node, statuses);
  if (!owner || fileMatchesPath(context.filename, owner.owner)) return;
  context.report({
    node,
    message: `String literal '${owner.value}' duplicates a canonical status from ${owner.owner}. Import the type instead.`,
  });
}

export function createOwnedUnionVisitors(context) {
  if (!isRuleFile(context)) return {};
  const sourceCode = context.sourceCode;
  const allows = new Set(context.options[0]?.allows ?? []);
  const statuses = context.options[0]?.statuses ?? {};
  let owners = [];
  function report(node, members, name) {
    if (!members || allows.has(name)) return false;
    const owner = owners.find(
      (candidate) =>
        candidate.members === members &&
        candidate.variable &&
        scopeVariable(sourceCode, node, candidate.binding) ===
          candidate.variable
    );
    if (owner) {
      context.report({
        node,
        messageId: "redeclaredOwner",
        data: { owner: owner.name },
      });
      return true;
    }
    return false;
  }
  return {
    Program(node) {
      owners = collectProgramOwners(node, context);
    },
    TSTypeAliasDeclaration(node) {
      if (node.typeAnnotation.type !== "TSUnionType") return false;
      return report(
        node.typeAnnotation,
        memberSet(node.typeAnnotation.types.map(astLiteralText)),
        node.id.name
      );
    },
    TSUnionType(node) {
      if (
        node.parent?.type === "TSTypeAliasDeclaration" ||
        node.parent?.type === "TSUnionType"
      ) {
        return false;
      }
      return report(
        node,
        memberSet(node.types.map(astLiteralText)),
        callSite(node)
      );
    },
    TSLiteralType(node) {
      reportStatusLiteral(node, statuses, context);
    },
    CallExpression(node) {
      return report(node, validatorMembers(node, sourceCode), callSite(node));
    },
  };
}
