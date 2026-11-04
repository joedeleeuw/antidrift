import { basename } from "node:path";
import {
  checkDecodedBlobEquality,
  checkPositionalOptions,
} from "./boundary-decode-checks.js";
import { constantEntries } from "./type-contracts.js";
import { topLevelTypeDeclarations } from "./type-predicate-checks.js";
import {
  checkIdentitySwitch,
  checkSchemaExports,
  checkUnionOwnership,
  createOwnedUnionVisitors,
  runtimeValidatorLiteralList,
} from "./no-redeclared-owned-union.js";
import {
  canonicalPropTypeText,
  classifyFileOriginPriority,
  getProgramIndex,
  unwrapOwnedCarrierType,
} from "../shared/program-index.js";
import {
  getResolvedType,
  getTypeServices,
  resolvedPropertyShape,
} from "../shared/type-services.js";
import { packageOwner } from "./package-owner.js";
import {
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import {
  findWidenedSchemaField,
  isSchemaFieldRename,
  isSchemaObjectOrExtendCall,
  resolveSchemaBuilderCall,
} from "../shared/runtime-schema-libraries.js";
import {
  isTestFile,
  splitIdentifierWords,
  staticPropertyKey,
} from "../shared/scope.js";

const MAP_TYPE_NAMES = new Set(["Map", "ReadonlyMap", "Record"]);
const GENERIC_BY_TARGETS = new Set(["Id", "Key", "ID", "Type", "Kind", "Name"]);
const STOP_PREFIXES = new Set([
  "active",
  "pending",
  "selected",
  "default",
  "initial",
  "current",
  "previous",
  "last",
  "next",
  "all",
  "raw",
  "should",
  "with",
  "from",
]);
const MAP_WRAPPER_NAMES = new Set(["Readonly", "Partial", "Required"]);
const ABSENT_TYPE_KINDS = new Set(["TSUndefinedKeyword", "TSNullKeyword"]);

function unwrapMapKeyType(typeNode) {
  let current = typeNode;
  for (let step = 0; current && step < 8; step += 1) {
    if (current.type === "TSUnionType") {
      const present = current.types.filter(
        (member) => !ABSENT_TYPE_KINDS.has(member.type)
      );
      if (present.length !== 1) return null;
      current = present[0];
      continue;
    }
    if (
      current.type === "TSTypeReference" &&
      current.typeName?.type === "Identifier" &&
      MAP_WRAPPER_NAMES.has(current.typeName.name) &&
      current.typeArguments?.params?.length === 1
    ) {
      current = current.typeArguments.params[0];
      continue;
    }
    return current;
  }
  return null;
}

function indexSignatureKeyNode(typeNode) {
  if (
    typeNode?.type === "TSTypeLiteral" &&
    typeNode.members.length === 1 &&
    typeNode.members[0].type === "TSIndexSignature"
  ) {
    return typeNode.members[0].parameters?.[0]?.typeAnnotation?.typeAnnotation;
  }
  if (
    typeNode?.type === "TSTypeReference" &&
    typeNode.typeName?.type === "Identifier" &&
    MAP_TYPE_NAMES.has(typeNode.typeName.name)
  ) {
    return typeNode.typeArguments?.params?.[0] ?? null;
  }
  return null;
}

function mapKeyTypeText(member, sourceCode) {
  if (member.computed || member.key?.type !== "Identifier") return null;
  if (member.type === "Property") {
    const builder = resolveSchemaBuilderCall(member.value, sourceCode);
    const keyNode =
      (builder?.method === "record" || builder?.method === "Record") &&
      builder.args.length >= 2
        ? builder.args[0]
        : null;
    return keyNode
      ? sourceCode.getText(keyNode).replaceAll(/\s+/gu, " ")
      : null;
  }
  if (
    member.type !== "TSPropertySignature" &&
    member.type !== "PropertyDefinition"
  ) {
    return null;
  }
  const typeNode = unwrapMapKeyType(member.typeAnnotation?.typeAnnotation);
  const keyArg = indexSignatureKeyNode(typeNode);
  return keyArg ? sourceCode.getText(keyArg).replaceAll(/\s+/gu, " ") : null;
}

function cohortTagForField(fieldName) {
  const byMatch = /By([A-Z][A-Za-z0-9]*?)(?:Id|Key|ID)?$/u.exec(fieldName);
  if (byMatch) {
    const entity = byMatch[1];
    return GENERIC_BY_TARGETS.has(entity) ? null : `by:${entity}`;
  }
  const prefixMatch = /^([a-z]{4,})[A-Z]/u.exec(fieldName);
  if (!prefixMatch) return null;
  const prefix = prefixMatch[1];
  return STOP_PREFIXES.has(prefix) ? null : `prefix:${prefix}`;
}

function checkParallelSidecarMaps(context, ownerName, members, reportNode) {
  if (!Array.isArray(members) || members.length < 3) return;
  const groups = new Map();
  for (const member of members) {
    const keyType = mapKeyTypeText(member, context.sourceCode);
    if (!keyType) continue;
    const fieldName = member.key.name;
    const tag = cohortTagForField(fieldName);
    if (!tag) continue;
    const groupKey = `${keyType}::${tag}`;
    const existing = groups.get(groupKey) ?? { keyType, fields: [] };
    existing.fields.push(fieldName);
    groups.set(groupKey, existing);
  }
  for (const group of groups.values()) {
    if (group.fields.length >= 3) {
      const sample = group.fields.slice(0, 3).join(", ");
      context.report({
        node: reportNode,
        message: `Type '${ownerName}' declares ${group.fields.length} parallel map fields (${sample}) keyed by '${group.keyType}'; consolidate per-key state into a single Map or Record of a domain entry type.`,
      });
      return;
    }
  }
}

function shapeSignature(members, sourceCode, minFields) {
  if (!Array.isArray(members) || members.length < minFields) return null;
  const fields = [];
  for (const member of members) {
    if (member.computed || member.key?.type !== "Identifier") return null;
    if (member.type === "Property" && member.value) {
      const valueText = sourceCode
        .getText(member.value)
        .replaceAll(/\s+/gu, " ");
      fields.push(`schema:${member.key.name}:${valueText}`);
      continue;
    }
    if (
      member.type !== "TSPropertySignature" ||
      !member.typeAnnotation?.typeAnnotation
    ) {
      return null;
    }
    const optional = member.optional ? "?" : "";
    const annotation = sourceCode
      .getText(member.typeAnnotation.typeAnnotation)
      .replaceAll(/\s+/gu, " ");
    fields.push(`${member.key.name}${optional}:${annotation}`);
  }
  return fields.toSorted().join(";");
}

function checkShape(context, state, name, members, reportNode) {
  const signature = shapeSignature(
    members,
    context.sourceCode,
    Math.min(2, state.fieldBlocks.minFields)
  );
  if (!signature) return;
  const existing = state.seenShapes.get(signature);
  if (existing && existing !== name) {
    context.report({
      node: reportNode,
      message: `Type '${name}' duplicates the exact ${members.length}-field shape of '${existing}'; reuse '${existing}' instead of forking a parallel contract.`,
    });
    return;
  }
  state.seenShapes.set(signature, name);
}

function redundantOwnerStem(typeName, fieldNames) {
  const [stem, ...rest] = splitIdentifierWords(typeName);
  return fieldNames.length >= 3 &&
    rest.length > 0 &&
    stem.length >= 3 &&
    fieldNames.every(
      (field) =>
        field.startsWith(stem) && /^[A-Z]/u.test(field.slice(stem.length))
    )
    ? stem
    : null;
}

function sharesIdentifierStem(left, right) {
  if (left === right) return true;
  const rightWords = new Set(
    splitIdentifierWords(right).filter((word) => word.length >= 3)
  );
  return splitIdentifierWords(left).some(
    (word) => word.length >= 3 && rightWords.has(word)
  );
}

function hasExactSamePropertyTypes(declaration, owner, fieldNames, sourceCode) {
  const services = getTypeServices(sourceCode);
  if (!services || !(owner.propTypes instanceof Map)) return true;
  const typeNode =
    declaration.type === "VariableDeclarator"
      ? declaration.init
      : (declaration.typeNode ?? declaration.id);
  const candType = unwrapOwnedCarrierType(
    getResolvedType(typeNode, sourceCode),
    services.checker
  );
  if (!candType) return false;
  return fieldNames.every((propName) => {
    const ownerText = owner.propTypes.get(propName);
    if (!ownerText) return false;
    const candSym = services.checker.getPropertyOfType(candType, propName);
    const candProp = candSym && services.checker.getTypeOfSymbol?.(candSym);
    const candText = canonicalPropTypeText(candProp, services.checker);
    return Boolean(candText && candText === ownerText);
  });
}

function extractNodeModulesPackageName(fileName) {
  const idx = fileName.lastIndexOf("/node_modules/");
  if (idx < 0) return null;
  const rest = fileName.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  if (parts[0]?.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

function isDeclaredNodeModulesOwner(ownerFileName, candidateFileName) {
  const pkgName = extractNodeModulesPackageName(ownerFileName);
  if (!pkgName) return false;
  const ownerPkg = packageOwner(candidateFileName);
  if (!ownerPkg?.manifest) return true;
  const manifest = ownerPkg.manifest;
  const deps = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const typesName = pkgName.startsWith("@")
    ? `@types/${pkgName.slice(1).replace("/", "__")}`
    : `@types/${pkgName}`;
  return deps.size === 0 || deps.has(pkgName) || deps.has(typesName);
}

function isAcceptedOwner(owner, declaration, filename, index, fieldCount = 3) {
  if (owner.fileName === filename) return false;
  if (
    (owner.origin === "node_modules" || fieldCount < 3) &&
    !sharesIdentifierStem(declaration.id.name, owner.name)
  ) {
    return false;
  }
  if (owner.origin === "node_modules") {
    if (
      fieldCount < 3 ||
      !isDeclaredNodeModulesOwner(owner.fileName, filename)
    ) {
      return false;
    }
  }
  const candidatePriority = classifyFileOriginPriority(filename);
  if (owner.priority < candidatePriority) {
    return true;
  }
  if (owner.priority !== candidatePriority) return false;
  const outerNode =
    declaration.type === "VariableDeclarator"
      ? declaration.parent
      : declaration;
  const isExported = outerNode?.parent?.type === "ExportNamedDeclaration";
  if (!isExported) return true;
  const ownerImports = index?.importCounts?.get(owner.name) ?? 0;
  const candidateImports = index?.importCounts?.get(declaration.id.name) ?? 0;
  if (ownerImports !== candidateImports) {
    return ownerImports > candidateImports;
  }
  return owner.fileName < filename;
}

function shouldSkipSameFileCandidate(bucket, declaration, filename) {
  if (declaration.typeNode) return false;
  const outerNode =
    declaration.type === "VariableDeclarator"
      ? declaration.parent
      : declaration;
  if (outerNode?.parent?.type === "ExportNamedDeclaration") return false;
  const candidatePriority = classifyFileOriginPriority(filename);
  return (
    bucket.some((entry) => entry.fileName === filename) &&
    !bucket.some(
      (entry) =>
        entry.fileName !== filename && entry.priority < candidatePriority
    )
  );
}

function checkProgramOwner(context, declaration, fieldNames, fieldBlocks) {
  const index = getProgramIndex(context.sourceCode);
  if (!index || fieldNames.length < 2) {
    return false;
  }
  const fieldKey = [...new Set(fieldNames)].toSorted().join(",");
  const filename = ruleFilename(context);
  const bucket = index.ownersByFieldKey?.get(fieldKey) ?? [];
  if (shouldSkipSameFileCandidate(bucket, declaration, filename)) {
    return false;
  }
  const owners = bucket.filter(
    (owner) =>
      isAcceptedOwner(owner, declaration, filename, index, fieldNames.length) &&
      hasExactSamePropertyTypes(
        declaration,
        owner,
        fieldNames,
        context.sourceCode
      )
  );
  if (owners.length === 0 || owners.length + 1 < fieldBlocks.minOccurrences) {
    return false;
  }
  const subjectKind =
    declaration.type === "VariableDeclarator" ? "Schema" : "Type";
  context.report({
    node: declaration.id,
    message: `${subjectKind} '${declaration.id.name}' restates the ${fieldNames.length}-field shape of exported '${owners[0].name}' (${basename(owners[0].fileName)}); import that owner instead of forking a local copy.`,
  });
  return true;
}

function extractUnionLiteralsFromTypes(types) {
  if (!Array.isArray(types) || types.length < 2) return null;
  const literals = [];
  for (const part of types) {
    if (
      part.type !== "TSLiteralType" ||
      typeof part.literal?.value !== "string"
    ) {
      return null;
    }
    literals.push(part.literal.value);
  }
  const unique = [...new Set(literals)].toSorted();
  return unique.length === literals.length ? unique : null;
}

function extractDeclaredUnionLiterals(node) {
  if (node.type === "TSEnumDeclaration") {
    const enumBody = node.body ?? node;
    const members = enumBody.members ?? [];
    if (members.length < 2) return null;
    const literals = [];
    for (const member of members) {
      const literalText =
        typeof member.initializer?.value === "string"
          ? member.initializer.value
          : member.id?.name;
      if (typeof literalText !== "string") return null;
      literals.push(literalText);
    }
    const unique = [...new Set(literals)].toSorted();
    return unique.length === literals.length ? unique : null;
  }
  if (node.typeAnnotation?.type !== "TSUnionType") return null;
  return extractUnionLiteralsFromTypes(node.typeAnnotation.types);
}

function reportMatchingUnionOwner(context, declaration, literals) {
  if (!declaration?.id?.name || !literals) return false;
  const index = getProgramIndex(context.sourceCode);
  if (!index) return false;
  const filename = ruleFilename(context);
  const bucket = index.ownersByUnionKey?.get(literals.join("|")) ?? [];
  if (shouldSkipSameFileCandidate(bucket, declaration, filename)) {
    return false;
  }
  const owner = bucket.find(
    (candidate) =>
      isAcceptedOwner(candidate, declaration, filename, index) &&
      (literals.length >= 3 ||
        sharesIdentifierStem(declaration.id.name, candidate.name))
  );
  if (!owner) return false;
  const subjectKind =
    declaration.type === "VariableDeclarator" ? "Schema" : "Type";
  context.report({
    node: declaration.id,
    message: `${subjectKind} '${declaration.id.name}' restates the ${literals.length}-member union of exported '${owner.name}' (${basename(owner.fileName)}); import that owner instead of redeclaring its literal values.`,
  });
  return true;
}

function checkProgramUnionOwner(context, declaration) {
  if (!declaration.id?.name) return;
  reportMatchingUnionOwner(
    context,
    declaration,
    extractDeclaredUnionLiterals(declaration)
  );
}

const PASSTHROUGH_SCHEMA_WRAPPERS = new Set([
  "strict",
  "passthrough",
  "strip",
  "readonly",
  "refine",
  "superRefine",
  "brand",
  "describe",
  "optional",
  "nullable",
  "nullish",
  "default",
]);

function passthroughWrapperParent(parent) {
  if (parent.type === "MemberExpression" && !parent.computed) {
    return PASSTHROUGH_SCHEMA_WRAPPERS.has(parent.property?.name)
      ? parent
      : null;
  }
  if (parent.type === "CallExpression") {
    const callee = parent.callee;
    const methodName =
      callee?.type === "MemberExpression" && !callee.computed
        ? callee.property?.name
        : null;
    return PASSTHROUGH_SCHEMA_WRAPPERS.has(methodName) ? parent : null;
  }
  return null;
}

function enclosingSchemaTarget(node, allowProperty) {
  let cur = node;
  while (cur?.parent) {
    const parent = cur.parent;
    if (
      parent.type === "VariableDeclarator" &&
      parent.id?.type === "Identifier"
    ) {
      return parent;
    }
    if (
      allowProperty &&
      parent.type === "Property" &&
      !parent.computed &&
      parent.key?.type === "Identifier" &&
      parent.value === cur
    ) {
      return {
        type: "VariableDeclarator",
        id: parent.key,
        init: cur,
        parent,
      };
    }
    cur = passthroughWrapperParent(parent);
  }
  return null;
}

function isNullableWrapperUnion(unionNode, innerNode) {
  return (
    unionNode?.type === "TSUnionType" &&
    unionNode.types.every(
      (part) =>
        part === innerNode ||
        part.type === "TSNullKeyword" ||
        part.type === "TSUndefinedKeyword"
    )
  );
}

function annotationHolderId(node, holder) {
  if (
    (holder?.type === "TSPropertySignature" ||
      holder?.type === "PropertyDefinition") &&
    !holder.computed &&
    holder.key?.type === "Identifier"
  ) {
    const isUnionBranchTag =
      node.type === "TSUnionType" &&
      holder.parent?.type === "TSTypeLiteral" &&
      holder.parent.parent?.type === "TSUnionType";
    return isUnionBranchTag ? null : holder.key;
  }
  if (holder?.type === "Identifier") return holder;
  return holder?.type === "AssignmentPattern" &&
    holder.left?.type === "Identifier"
    ? holder.left
    : null;
}

function declaratorTargetId(declId) {
  if (declId?.type === "Identifier") return declId;
  if (
    declId?.type === "ArrayPattern" &&
    declId.elements[0]?.type === "Identifier"
  ) {
    return declId.elements[0];
  }
  return null;
}

function enclosingInlineTypeTarget(node) {
  const outer = isNullableWrapperUnion(node.parent, node) ? node.parent : node;
  const parent = outer.parent;
  if (parent?.type === "TSTypeAnnotation") {
    const id = annotationHolderId(node, parent.parent);
    return id
      ? { type: "TSTypeLiteral", id, typeNode: node, parent: parent.parent }
      : null;
  }
  if (parent?.type === "TSTypeParameterInstantiation") {
    const call = parent.parent;
    const declarator =
      call?.type === "CallExpression" &&
      call.parent?.type === "VariableDeclarator"
        ? call.parent
        : null;
    const id = declaratorTargetId(declarator?.id);
    return id
      ? { type: "TSTypeLiteral", id, typeNode: node, parent: declarator }
      : null;
  }
  return null;
}

function checkRuntimeSchemaFork(node, context, state, reportedLocalUnion) {
  const objectCall = isSchemaObjectOrExtendCall(node, context.sourceCode);
  if (objectCall && !objectCall.baseSchemaNode) {
    const declarator = enclosingSchemaTarget(node, true);
    if (!declarator) return;
    const properties = objectCall.shapeNode.properties;
    const name = declarator.id.name;
    checkParallelSidecarMaps(context, name, properties, declarator.id);
    checkShape(context, state, name, properties, declarator.id);
    const fieldNames = properties.map(staticPropertyKey);
    if (fieldNames.length > 0 && fieldNames.every(Boolean)) {
      const stem = redundantOwnerStem(name.replace(/Schema$/u, ""), fieldNames);
      if (stem) {
        context.report({
          node: declarator.id,
          message: `Schema '${name}' prefixes all ${fieldNames.length} fields with '${stem}'; drop the redundant owner prefix from field names.`,
        });
      }
      checkProgramOwner(context, declarator, fieldNames, state.fieldBlocks);
    }
    return;
  }
  if (reportedLocalUnion) return;
  const target = enclosingSchemaTarget(node, true);
  if (!target) return;
  const rawTokens = runtimeValidatorLiteralList(node, context.sourceCode);
  if (!rawTokens || !rawTokens.every((entry) => typeof entry === "string")) {
    return;
  }
  const unique = [...new Set(rawTokens)].toSorted();
  if (unique.length !== rawTokens.length) return;
  if (reportMatchingUnionOwner(context, target, unique)) return;
  const unionKey = unique.join("|");
  const prevName = state.seenRuntimeUnions.get(unionKey);
  if (prevName && sharesIdentifierStem(target.id.name, prevName)) {
    context.report({
      node: target.id,
      message: `Schema '${target.id.name}' restates the ${unique.length}-member union of '${prevName}' in this module; extract and reuse one shared union validator.`,
    });
    return;
  }
  if (!prevName) {
    state.seenRuntimeUnions.set(unionKey, target.id.name);
  }
}

function extractOmitClause(nodes) {
  for (const node of nodes ?? []) {
    const refName = node.typeName?.name ?? node.expression?.name;
    const typeArgs = node.typeArguments?.params;
    if (refName !== "Omit" || typeArgs?.length !== 2) continue;
    const [baseType, keysType] = typeArgs;
    let omittedKeys = null;
    if (
      keysType.type === "TSLiteralType" &&
      typeof keysType.literal?.value === "string"
    ) {
      omittedKeys = [keysType.literal.value];
    } else if (keysType.type === "TSUnionType") {
      omittedKeys = extractUnionLiteralsFromTypes(keysType.types);
    }
    if (omittedKeys?.length) return { baseType, omittedKeys };
  }
  return null;
}

function isWidenedTypeMember(member) {
  if (member?.optional) return true;
  const ann = member?.typeAnnotation?.typeAnnotation;
  return (
    ann?.type === "TSUnionType" &&
    ann.types.some((part) => ABSENT_TYPE_KINDS.has(part.type))
  );
}

function localBaseMembers(baseType, typeDeclarations) {
  if (
    baseType?.type !== "TSTypeReference" ||
    baseType.typeName?.type !== "Identifier"
  ) {
    return null;
  }
  const decl = typeDeclarations.get(baseType.typeName.name);
  const members = decl?.body?.body ?? decl?.typeAnnotation?.members;
  return Array.isArray(members) ? members : null;
}

function baseFieldIsStrict(baseMembers, baseShape, fieldName) {
  if (baseMembers) {
    const match = baseMembers.find(
      (member) => staticPropertyKey(member) === fieldName
    );
    return Boolean(match && !isWidenedTypeMember(match));
  }
  return baseShape && baseShape.all.length > 0
    ? baseShape.required.includes(fieldName)
    : true;
}

function isOmitTypeRename(baseMembers, omittedKeys, addedMembers, sourceCode) {
  if (!baseMembers || addedMembers.length !== omittedKeys.length) return false;
  const addedNames = addedMembers.map(staticPropertyKey);
  if (
    !addedNames.every(Boolean) ||
    omittedKeys.some((key) => addedNames.includes(key))
  ) {
    return false;
  }
  const baseTexts = new Map(
    baseMembers.flatMap((member) => {
      const key = staticPropertyKey(member);
      const ann = member.typeAnnotation?.typeAnnotation;
      return key && ann ? [[key, sourceCode.getText(ann).trim()]] : [];
    })
  );
  const addedTexts = new Set(
    addedMembers.flatMap((member) => {
      const ann = member.typeAnnotation?.typeAnnotation;
      return ann ? [sourceCode.getText(ann).trim()] : [];
    })
  );
  return omittedKeys.every(
    (key) => baseTexts.has(key) && addedTexts.has(baseTexts.get(key))
  );
}

function checkOmitTypeFork(
  declaration,
  omitNodes,
  addedMembers,
  state,
  context
) {
  const omitClause = extractOmitClause(omitNodes);
  if (
    !omitClause ||
    !Array.isArray(addedMembers) ||
    addedMembers.length === 0
  ) {
    return;
  }
  const { baseType, omittedKeys } = omitClause;
  const baseMembers = localBaseMembers(baseType, state.typeDeclarations);
  if (
    isOmitTypeRename(baseMembers, omittedKeys, addedMembers, context.sourceCode)
  ) {
    context.report({
      node: declaration.id,
      message:
        "Type omits and renames fields from its base contract; share a base type or transform at the boundary.",
    });
    return;
  }
  const baseShape = baseMembers
    ? null
    : resolvedPropertyShape(baseType, context.sourceCode);
  for (const member of addedMembers) {
    const fieldName = staticPropertyKey(member);
    if (
      fieldName &&
      omittedKeys.includes(fieldName) &&
      isWidenedTypeMember(member) &&
      baseFieldIsStrict(baseMembers, baseShape, fieldName)
    ) {
      context.report({
        node: member,
        message: `Type '${declaration.id.name}' omits and widens existing field '${fieldName}' to optional/nullable; keep the canonical contract strict or declare an explicit wire type at the boundary.`,
      });
    }
  }
}

function checkTypeDeclaration(context, state, declaration, members) {
  const name = declaration.id.name;
  checkParallelSidecarMaps(context, name, members, declaration.id);
  if (declaration.extends?.length) {
    checkOmitTypeFork(
      declaration,
      declaration.extends,
      members,
      state,
      context
    );
    return;
  }
  checkShape(context, state, name, members, declaration.id);
  const fieldNames = (members ?? []).map((member) =>
    member.type === "TSPropertySignature" ? staticPropertyKey(member) : null
  );
  if (fieldNames.length === 0 || !fieldNames.every(Boolean)) return;
  const stem = redundantOwnerStem(name, fieldNames);
  if (stem) {
    context.report({
      node: declaration.id,
      message: `Type '${name}' prefixes all ${fieldNames.length} fields with '${stem}'; drop the redundant owner prefix from field names.`,
    });
  }
  checkProgramOwner(context, declaration, fieldNames, state.fieldBlocks);
}

function recordConstantLiteral(node, literalCounts) {
  const entries = constantEntries(node);
  if (
    entries.size < 3 ||
    entries.size !== node.properties.length ||
    node.parent?.type === "ArrayExpression" ||
    (node.parent?.type === "Property" && node.parent.value === node)
  ) {
    return;
  }
  const signature = [...entries]
    .map(([key, raw]) => `${key}=${raw}`)
    .toSorted()
    .join(";");
  const seen = literalCounts.get(signature);
  literalCounts.set(signature, {
    node: seen?.node ?? node,
    count: (seen?.count ?? 0) + 1,
  });
}

function checkSchemaRename(node, context) {
  if (isSchemaFieldRename(node, context.sourceCode)) {
    context.report({
      node,
      message:
        "Schema `.omit().extend()` forks the schema shape by renaming fields; share a base schema or transform at the boundary.",
    });
    return;
  }
  const widened = findWidenedSchemaField(node, context.sourceCode);
  if (widened) {
    context.report({
      node: widened.node,
      message: `Schema \`.extend()\` widens existing field '${widened.fieldName}' with \`.${widened.method}()\`; keep the canonical contract strict or declare an explicit wire schema that normalizes at the parse boundary.`,
    });
  }
}

function unionOwnershipVisitors(context, state, ownedUnionVisitors) {
  return {
    Program(node) {
      state.typeDeclarations = topLevelTypeDeclarations(node);
      checkSchemaExports(node, context);
      ownedUnionVisitors.Program?.(node);
    },
    CallExpression(node) {
      checkSchemaRename(node, context);
      checkUnionOwnership(node, context, state.typeDeclarations);
      const reportedLocalUnion = ownedUnionVisitors.CallExpression?.(node);
      checkRuntimeSchemaFork(node, context, state, reportedLocalUnion);
    },
    MemberExpression(node) {
      checkPositionalOptions(node, context);
    },
    TSLiteralType(node) {
      ownedUnionVisitors.TSLiteralType?.(node);
    },
    TSUnionType(node) {
      checkUnionOwnership(node, context, state.typeDeclarations);
      const reportedLocal = ownedUnionVisitors.TSUnionType?.(node);
      if (!reportedLocal) {
        const target = enclosingInlineTypeTarget(node);
        if (target) {
          reportMatchingUnionOwner(
            context,
            target,
            extractUnionLiteralsFromTypes(node.types)
          );
        }
      }
    },
    SwitchStatement(node) {
      checkIdentitySwitch(node, context);
    },
  };
}

function checkInlineTypeLiteral(node, context, state) {
  const target = enclosingInlineTypeTarget(node);
  if (!target) return;
  const fieldNames = (node.members ?? []).map((member) =>
    member.type === "TSPropertySignature" ? staticPropertyKey(member) : null
  );
  if (
    fieldNames.length > 0 &&
    fieldNames.every(Boolean) &&
    checkProgramOwner(context, target, fieldNames, state.fieldBlocks)
  ) {
    return;
  }
  checkShape(context, state, target.id.name, node.members, target.id);
}

function checkTypeAliasDeclaration(node, context, state, reportedLocal) {
  if (node.id?.name && node.typeAnnotation?.type === "TSTypeLiteral") {
    checkTypeDeclaration(context, state, node, node.typeAnnotation.members);
    return;
  }
  if (node.id?.name && node.typeAnnotation?.type === "TSIntersectionType") {
    const addedMembers = node.typeAnnotation.types.flatMap((part) =>
      part.type === "TSTypeLiteral" ? (part.members ?? []) : []
    );
    checkOmitTypeFork(
      node,
      node.typeAnnotation.types,
      addedMembers,
      state,
      context
    );
    return;
  }
  if (!reportedLocal) {
    checkProgramUnionOwner(context, node);
  }
}

function typeShapeVisitors(context, state, ownedUnionVisitors) {
  return {
    BinaryExpression(node) {
      checkDecodedBlobEquality(node, context);
    },
    ObjectExpression(node) {
      if (!isTestFile(ruleFilename(context))) {
        recordConstantLiteral(node, state.literalCounts);
      }
    },
    TSInterfaceDeclaration(node) {
      if (node.id?.name) {
        checkTypeDeclaration(context, state, node, node.body?.body);
      }
    },
    TSTypeAliasDeclaration(node) {
      const reportedLocal = ownedUnionVisitors.TSTypeAliasDeclaration?.(node);
      checkTypeAliasDeclaration(node, context, state, reportedLocal);
    },
    TSTypeLiteral(node) {
      checkInlineTypeLiteral(node, context, state);
    },
    TSEnumDeclaration(node) {
      checkProgramUnionOwner(context, node);
    },
    ClassDeclaration(node) {
      if (node.id?.name) {
        checkParallelSidecarMaps(
          context,
          node.id.name,
          node.body?.body,
          node.id
        );
      }
    },
    "Program:exit"() {
      for (const { node, count } of state.literalCounts.values()) {
        if (count < 3) continue;
        context.report({
          node,
          message: `Identical constant object literal is repeated ${count} times in this module; extract a shared constant and reuse or spread it.`,
        });
      }
    },
  };
}

export const noStructuralTypeForkRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow forked type and schema shapes: duplicate or cross-file restated object types, redeclared owned literal unions, positional `.options` reads, degenerate or unfactored discriminated unions, identity discriminator switches, owner-prefixed fields, repeated constant literals, and decoded blobs that restate sibling columns.",
    },
    messages: {
      redeclaredOwner:
        "This union re-declares an owned literal value space; derive it from the owning runtime array {{owner}}.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          allows: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          statuses: { type: "object" },
          fieldBlocks: {
            type: "object",
            properties: {
              minFields: { type: "number" },
              minOccurrences: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const state = {
      fieldBlocks: {
        minFields: 3,
        minOccurrences: 2,
        ...context.options[0]?.fieldBlocks,
      },
      seenShapes: new Map(),
      seenRuntimeUnions: new Map(),
      literalCounts: new Map(),
      typeDeclarations: new Map(),
    };
    const ownedUnionVisitors = createOwnedUnionVisitors(context);
    return {
      ...unionOwnershipVisitors(context, state, ownedUnionVisitors),
      ...typeShapeVisitors(context, state, ownedUnionVisitors),
    };
  },
};
