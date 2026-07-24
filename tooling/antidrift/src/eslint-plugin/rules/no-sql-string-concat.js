import ts from "typescript";
import {
  getFunctionNode,
  unwrapExpression,
} from "../../semantic-adapters/local-ast-rules.mjs";
import {
  isSqlDirectionTokenValue,
  isSqlIdentifierContext,
  isSqlIdentifierTokenValue,
  isSqlInterpolationContext,
  safeIdentifierMemberSpecs,
  safeTemplateTagSpecs,
  templateStaticPartsAreSqlIdentifierSafe,
  valuesAreSqlDirections,
  valuesAreSqlIdentifiers,
} from "../../semantic-adapters/sql.mjs";
import {
  findVariable,
  getDeclaredVariable,
} from "../../semantic-adapters/async-control-flow.mjs";
import { requireTypeServices } from "./type-services.js";
import {
  containsSqlPrefix,
  containsSqlStatement,
  templateText,
  staticStringValue,
  singleReturnExpression,
  sqlEscaperFunctionKind,
  tsSqlEscaperDeclarationKind,
  isUnquotedSqlInterpolation,
  intersectPropertySets,
  collectReturnArguments,
  isStaticFragmentMapJoin,
  isPlaceholderSqlFragmentMapJoin,
  transparentRawSqlFragmentExpression,
  unsafeTrustedRawSqlChildren,
  isEmptyArrayExpression,
  isAllowedSqlFragmentJoinSeparator,
  sqlTypePropertyValues,
  sqlPropertyKeyName,
  isSqlIdentifierRegexLiteral,
  assignedSqlIdentifierNode,
  classMemberKey,
  enclosingClass,
  statementExits,
  unionStringValues,
  variableTypeNode,
  objectLiteralIdentifierValues,
  templateInterpolationParts,
  declarationOwnerNames,
  declarationSourceMatches,
  importedSpecifierName,
  importSourceValue,
} from "./sql-syntax-analysis.js";

export function ruleNoSqlStringConcat() {
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
            safeTemplateTags: {
              type: "array",
              items: {
                type: "object",
                oneOf: [
                  {
                    properties: {
                      module: { type: "string" },
                      export: { type: "string" },
                      evidence: { type: "string" },
                    },
                    required: ["module", "export"],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { type: "string" },
                      member: { type: "string" },
                      source: { type: "string", pattern: String.raw`[/\\]` },
                      evidence: { type: "string" },
                    },
                    required: ["type", "member", "source"],
                    additionalProperties: false,
                  },
                ],
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
      const safeTemplateTags = safeTemplateTagSpecs(context.options[0] ?? {});
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
        if (!kind) {
          return;
        }
        const variable = getDeclaredVariable(sourceCode, node);
        if (variable) {
          sqlEscaperFunctions.set(variable, kind);
        }
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
        if (declaration?.type !== "VariableDeclaration") {
          return;
        }
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
          if (kind) {
            return kind;
          }
        }
        return null;
      }
      function sqlEscaperCallKind(node) {
        if (node?.type !== "CallExpression" || node.arguments.length !== 1) {
          return null;
        }
        if (node.callee?.type !== "Identifier") {
          return null;
        }
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
        if (params.some((param) => param.type !== "Identifier")) {
          return null;
        }
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
        if (!summary) {
          return;
        }
        const variable = getDeclaredVariable(sourceCode, node);
        if (variable) {
          safeSqlFragmentFunctions.set(variable, summary);
        }
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
        if (declaration?.type !== "VariableDeclaration") {
          return;
        }
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
        if (!summary || node.arguments.length !== summary.arity) {
          return false;
        }
        return summary.identifierParams.every((index) =>
          isSafeSqlIdentifierExpression(node.arguments[index]),
        );
      }
      function isSqlEscaperMapJoin(node, kind, separators) {
        if (node?.type !== "CallExpression") {
          return false;
        }
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
        if (!separators.has(separator)) {
          return false;
        }
        const mapCall = join.object;
        if (mapCall?.type !== "CallExpression") {
          return false;
        }
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
        if (node?.type !== "CallExpression") {
          return false;
        }
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
        if (mapCall?.type !== "CallExpression") {
          return false;
        }
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
        if (node?.type !== "TemplateLiteral") {
          return false;
        }
        for (let i = 0; i < node.expressions.length; i += 1) {
          const expression = node.expressions[i];
          const { before, after } = templateInterpolationParts(node, i);
          if (
            expression.type === "Identifier" &&
            paramNames.has(expression.name)
          ) {
            if (!isUnquotedSqlInterpolation(before, after)) {
              return false;
            }
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
        if (staticStringValue(node) !== null) {
          return true;
        }
        if (sqlEscaperCallKind(node) === "string") {
          return true;
        }
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
        if (variable) {
          safeDynamicSqlIdentifierVariables.add(variable);
        }
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
        if (key && classNode) {
          classSafeMembers(classNode).add(key);
        }
      }
      function unmarkDynamicSqlIdentifierMember(node) {
        const key = classMemberKey(node);
        const classNode = key && enclosingClass(node);
        const members = classNode
          ? safeDynamicSqlIdentifierMembers.get(classNode)
          : null;
        if (key && members) {
          members.delete(key);
        }
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
        if (!propertyName) {
          return null;
        }
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
      function typeMatchesTrustedMemberSpec(type, member, candidates) {
        const property = checker.getPropertyOfType(type, member);
        for (const declaration of property?.declarations ?? []) {
          const owners = declarationOwnerNames(declaration);
          if (candidates.some(({ type: typeName }) => owners.has(typeName))) {
            return true;
          }
        }
        return false;
      }
      function typeMatchesTrustedTemplateMemberSpec(type, member, candidates) {
        const property = checker.getPropertyOfType(type, member);
        for (const declaration of property?.declarations ?? []) {
          const owners = declarationOwnerNames(declaration);
          if (
            candidates.some(
              ({ type: typeName, source }) =>
                owners.has(typeName) &&
                declarationSourceMatches(declaration, source),
            )
          ) {
            return true;
          }
        }
        return false;
      }
      function isConfiguredSafeSqlIdentifierMember(node) {
        if (!checker || safeIdentifierMembers.length === 0) {
          return false;
        }
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
        if (candidates.length === 0) {
          return false;
        }
        const tsObject = services?.esTreeNodeToTSNodeMap?.get(node.object);
        if (!tsObject) {
          return false;
        }
        return typeMatchesTrustedMemberSpec(
          checker.getTypeAtLocation(tsObject),
          node.property.name,
          candidates,
        );
      }
      function isTrustedImportedTemplateTag(node) {
        if (
          node?.type !== "Identifier" ||
          safeTemplateTags.imported.length === 0
        ) {
          return false;
        }
        const variable = findVariable(sourceCode, node);
        const importDef = variable?.defs?.find(
          (def) => def.type === "ImportBinding",
        );
        const source = importSourceValue(importDef);
        const imported = importedSpecifierName(importDef);
        return safeTemplateTags.imported.some(
          (spec) => spec.module === source && spec.exportName === imported,
        );
      }
      function isTrustedImportedBuilderMemberCall(node, member) {
        const callee = node?.callee;
        return (
          node?.type === "CallExpression" &&
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          callee.property?.type === "Identifier" &&
          callee.property.name === member &&
          isTrustedImportedTemplateTag(callee.object)
        );
      }
      function isTrustedMemberBuilderMemberCall(node, member) {
        const callee = node?.callee;
        return (
          node?.type === "CallExpression" &&
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          callee.property?.type === "Identifier" &&
          callee.property.name === member &&
          isTrustedMemberTemplateTag(callee.object)
        );
      }
      function isUnsafeTrustedRawSqlBuilderCall(node) {
        return (
          (isTrustedImportedBuilderMemberCall(node, "raw") ||
            isTrustedMemberBuilderMemberCall(node, "raw")) &&
          node.arguments.some(
            (argument) => staticStringValue(argument) === null,
          )
        );
      }
      function isUnsafeTrustedRawSqlFragment(node) {
        const transparent = transparentRawSqlFragmentExpression(node);
        if (transparent) {
          return isUnsafeTrustedRawSqlFragment(transparent);
        }
        if (isUnsafeTrustedRawSqlBuilderCall(node)) {
          return true;
        }
        return unsafeTrustedRawSqlChildren(node).some(
          isUnsafeTrustedRawSqlFragment,
        );
      }
      function reportUnsafeTrustedRawSqlFragments(node) {
        let reported = false;
        for (const expression of node.expressions) {
          if (!isUnsafeTrustedRawSqlFragment(expression)) {
            continue;
          }
          context.report({
            node: expression,
            message:
              "Do not pass dynamic values through raw SQL builder fragments. Use bound parameters or a proven identifier escape.",
          });
          reported = true;
        }
        return reported;
      }
      function isTrustedMemberTemplateTag(node) {
        if (!checker || safeTemplateTags.members.length === 0) {
          return false;
        }
        if (
          node?.type !== "MemberExpression" ||
          node.computed ||
          node.property?.type !== "Identifier"
        ) {
          return false;
        }
        const candidates = safeTemplateTags.members.filter(
          ({ member }) => member === node.property.name,
        );
        if (candidates.length === 0) {
          return false;
        }
        const tsObject = services?.esTreeNodeToTSNodeMap?.get(node.object);
        if (!tsObject) {
          return false;
        }
        return typeMatchesTrustedTemplateMemberSpec(
          checker.getTypeAtLocation(tsObject),
          node.property.name,
          candidates,
        );
      }
      function isTrustedSqlTemplateTag(node) {
        if (node?.type === "TSNonNullExpression") {
          return isTrustedSqlTemplateTag(node.expression);
        }
        if (node?.type === "ChainExpression") {
          return isTrustedSqlTemplateTag(node.expression);
        }
        return (
          isTrustedImportedTemplateTag(node) || isTrustedMemberTemplateTag(node)
        );
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
        if (node.arguments.length > 0) {
          return null;
        }
        const callee = node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.type !== "Identifier"
        ) {
          return null;
        }
        const sourceValues = sqlTokenValues(callee.object);
        if (!sourceValues) {
          return null;
        }
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
        if (staticValue !== null) {
          return new Set([staticValue]);
        }
        const unwrapped = unwrapExpression(node);
        if (unwrapped !== node) {
          return sqlTokenValues(unwrapped);
        }
        if (node?.type === "Identifier") {
          return identifierTokenValues(node);
        }
        if (node?.type === "MemberExpression") {
          return memberTokenValues(node);
        }
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
        if (sqlEscaperCallKind(node) === "identifier") {
          return true;
        }
        if (isSqlEscaperMapJoin(node, "identifier", new Set(["."]))) {
          return true;
        }
        const values = sqlTokenValues(node);
        if (valuesAreSqlIdentifiers(values)) {
          return true;
        }
        if (isSafeDynamicSqlIdentifierVariable(node)) {
          return true;
        }
        if (isConfiguredSafeSqlIdentifierMember(node)) {
          return true;
        }
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
          if (!state.safe) {
            return false;
          }
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
        if (isDirectSafeSqlFragmentExpression(node)) {
          return true;
        }
        if (node?.type === "Identifier") {
          return isSafeFragmentVariable(node, safeSqlFragmentStrings);
        }
        if (isSafeFragmentMember(node)) {
          return true;
        }
        if (node?.type === "ConditionalExpression") {
          return (
            isSafeSqlFragmentExpression(node.consequent) &&
            isSafeSqlFragmentExpression(node.alternate)
          );
        }
        if (node?.type === "TemplateLiteral") {
          return isSafeSqlTemplateLiteral(node);
        }
        if (node?.type !== "CallExpression") {
          return false;
        }
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
        if (!isAllowedSqlFragmentJoinSeparator(separator)) {
          return false;
        }
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
        if (node?.type !== "ObjectExpression") {
          return null;
        }
        const properties = new Set();
        for (const property of node.properties ?? []) {
          if (property.type !== "Property" || property.computed) {
            return null;
          }
          const key = sqlPropertyKeyName(property.key);
          if (!key || !isSafeSqlFragmentExpression(property.value)) {
            return null;
          }
          properties.add(key);
        }
        return properties;
      }
      function returnedObjectSqlFragmentProperties(node) {
        const returns = [];
        collectReturnArguments(node, returns);
        if (returns.length === 0) {
          return null;
        }
        let properties = null;
        for (const argument of returns) {
          const returned = objectSqlFragmentProperties(argument);
          if (!returned) {
            return null;
          }
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
        if (!statementExits(node.consequent)) {
          return null;
        }
        const test = node.test;
        const call =
          test?.type === "UnaryExpression" && test.operator === "!"
            ? test.argument
            : null;
        if (call?.type !== "CallExpression") {
          return null;
        }
        const callee = call.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed ||
          callee.property?.type !== "Identifier" ||
          callee.property.name !== "test"
        ) {
          return null;
        }
        if (callee.object?.type !== "Identifier") {
          return null;
        }
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
          if (!variable) {
            return;
          }
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
          if (!assignedIdentifier) {
            return;
          }
          const variable = findVariable(sourceCode, assignedIdentifier);
          if (!variable) {
            return;
          }
          safeSqlFragmentArrays.delete(variable);
          safeSqlFragmentStrings.delete(variable);
          unmarkSqlIdentifierVariable(variable);
        },
        IfStatement(node) {
          const identifier = guardedSqlIdentifierVariable(node);
          if (identifier) {
            markDynamicSqlIdentifierVariable(identifier);
          }
        },
        "AssignmentExpression:exit"(node) {
          if (node.left?.type !== "MemberExpression") {
            return;
          }
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
          if (callee.object?.type !== "Identifier") {
            return;
          }
          const variable = findVariable(sourceCode, callee.object);
          if (!variable || !safeSqlFragmentArrays.has(variable)) {
            return;
          }
          if (
            !node.arguments.every((arg) => isSafeSqlFragmentExpression(arg))
          ) {
            safeSqlFragmentArrays.delete(variable);
          }
        },
        TaggedTemplateExpression(node) {
          if (isTrustedSqlTemplateTag(node.tag)) {
            if (reportUnsafeTrustedRawSqlFragments(node.quasi)) {
              return;
            }
            return;
          }
          if (
            node.quasi.expressions.length > 0 &&
            containsSqlStatement(templateText(node.quasi))
          ) {
            if (!hasUnsafeSqlInterpolation(node.quasi)) {
              return;
            }
            context.report({
              node: node.quasi,
              message:
                "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
        TemplateLiteral(node) {
          if (
            node.parent?.type === "TaggedTemplateExpression" &&
            node.parent.quasi === node
          ) {
            return;
          }
          if (
            node.expressions.length > 0 &&
            containsSqlStatement(templateText(node))
          ) {
            if (!hasUnsafeSqlInterpolation(node)) {
              return;
            }
            context.report({
              node,
              message:
                "Do not interpolate values into SQL strings. Use parameterized queries / bound parameters.",
            });
          }
        },
        BinaryExpression(node) {
          if (node.operator !== "+") {
            return;
          }
          const sides = [node.left, node.right];
          const hasSqlLiteral = sides.some(
            (side) =>
              side?.type === "Literal" &&
              typeof side.value === "string" &&
              containsSqlPrefix(side.value),
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
