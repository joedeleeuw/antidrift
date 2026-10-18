import type ts from "typescript";

import { findVariable } from "../kernel/async-control-flow.ts";
import type { TypeScriptParserServices } from "../kernel/rule-kernel.ts";
import type { SyntaxNode } from "../kernel/syntax-node.ts";
import {
  fieldOf,
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import { bindingDefinitions } from "../kernel/syntax-scope.ts";
import type {
  SafeIdentifierMemberSpec,
  SafeTemplateMemberTagSpec,
  SafeTemplateTagSpecs,
} from "./sql.ts";
import { methodReceiver, staticString } from "./sql-syntax.ts";

export type SqlProvenanceContext = {
  readonly sourceCode: unknown;
  readonly safeIdentifierMembers: readonly SafeIdentifierMemberSpec[];
  readonly safeTemplateTags: SafeTemplateTagSpecs;
  readonly services: TypeScriptParserServices | null;
  readonly checker: ts.TypeChecker | null;
};

type TrustedMemberSpec = SafeIdentifierMemberSpec | SafeTemplateMemberTagSpec;

const RAW_FRAGMENT_EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "ChainExpression",
]);

const RAW_FRAGMENT_ARGUMENT_WRAPPERS = new Set([
  "UnaryExpression",
  "AwaitExpression",
]);

const TEMPLATE_TAG_WRAPPERS = new Set([
  "TSNonNullExpression",
  "ChainExpression",
]);

function spreadTarget(argument: unknown): unknown {
  return isSyntaxType(argument, "SpreadElement")
    ? syntaxField(argument, "argument")
    : argument;
}

function propertyChildren(property: unknown): readonly unknown[] {
  if (isSyntaxType(property, "SpreadElement")) {
    return [syntaxField(property, "argument")];
  }
  const assignedExpression = syntaxField(property, "value");
  return syntaxField(property, "computed") === true
    ? [syntaxField(property, "key"), assignedExpression]
    : [assignedExpression];
}

const RAW_SQL_CHILDREN = new Map<
  string,
  (node: SyntaxNode) => readonly unknown[]
>([
  [
    "ConditionalExpression",
    (node) => [
      syntaxField(node, "test"),
      syntaxField(node, "consequent"),
      syntaxField(node, "alternate"),
    ],
  ],
  [
    "LogicalExpression",
    (node) => [syntaxField(node, "left"), syntaxField(node, "right")],
  ],
  [
    "BinaryExpression",
    (node) => [syntaxField(node, "left"), syntaxField(node, "right")],
  ],
  ["SequenceExpression", (node) => syntaxChildren(node, "expressions")],
  [
    "CallExpression",
    (node) => [
      syntaxField(node, "callee"),
      ...syntaxChildren(node, "arguments").map(spreadTarget),
    ],
  ],
  [
    "MemberExpression",
    (node) =>
      syntaxField(node, "computed") === true
        ? [syntaxField(node, "object"), syntaxField(node, "property")]
        : [syntaxField(node, "object")],
  ],
  ["ArrayExpression", (node) => syntaxChildren(node, "elements")],
  [
    "ObjectExpression",
    (node) => syntaxChildren(node, "properties").flatMap(propertyChildren),
  ],
  [
    "TaggedTemplateExpression",
    (node) => [syntaxField(node, "tag"), syntaxField(node, "quasi")],
  ],
  ["TemplateLiteral", (node) => syntaxChildren(node, "expressions")],
]);

function unsafeTrustedRawSqlChildren(node: unknown): readonly unknown[] {
  if (!isSyntaxNode(node)) {
    return [];
  }
  return RAW_SQL_CHILDREN.get(node.type)?.(node) ?? [];
}

function transparentRawSqlFragmentExpression(node: unknown) {
  if (!isSyntaxNode(node)) {
    return null;
  }
  if (RAW_FRAGMENT_EXPRESSION_WRAPPERS.has(node.type)) {
    return syntaxField(node, "expression");
  }
  return RAW_FRAGMENT_ARGUMENT_WRAPPERS.has(node.type)
    ? syntaxField(node, "argument")
    : null;
}

function importedSpecifierName(definition: unknown): unknown {
  const specifier = fieldOf(definition, "node");
  if (!isSyntaxType(specifier, "ImportSpecifier")) {
    return identifierName(syntaxField(specifier, "local"));
  }
  const imported = syntaxField(specifier, "imported");
  return isSyntaxType(imported, "Identifier")
    ? identifierName(imported)
    : syntaxField(imported, "value");
}

function importSourceSpecifier(definition: unknown): unknown {
  return (
    syntaxField(
      syntaxField(fieldOf(definition, "parent"), "source"),
      "value"
    ) ??
    syntaxField(
      syntaxField(syntaxField(fieldOf(definition, "node"), "parent"), "source"),
      "value"
    )
  );
}

function declarationOwnerNames(
  declaration: ts.Declaration
): ReadonlySet<string> {
  const { parent } = declaration;
  const ownerName = fieldOf(fieldOf(parent, "name"), "text");
  return new Set(
    [
      typeof ownerName === "string" ? ownerName : "",
      parent.symbol?.getName() ?? "",
      parent.localSymbol?.getName() ?? "",
    ].filter(Boolean)
  );
}

function declarationSourceMatches(
  declaration: ts.Declaration,
  source: string
): boolean {
  return declaration
    .getSourceFile()
    .fileName.replace(/\\/gu, "/")
    .endsWith(source.replace(/\\/gu, "/"));
}

export class SqlTrustedSources {
  readonly #context: SqlProvenanceContext;

  constructor(context: SqlProvenanceContext) {
    this.#context = context;
  }

  isTrustedMemberOnReceiver(node: unknown, requireSourceMatch: boolean) {
    const { checker, services, safeIdentifierMembers, safeTemplateTags } =
      this.#context;
    const specs: readonly TrustedMemberSpec[] = requireSourceMatch
      ? safeTemplateTags.members
      : safeIdentifierMembers;
    const propertyName = identifierName(syntaxField(node, "property"));
    if (
      !checker ||
      specs.length === 0 ||
      !isSyntaxType(node, "MemberExpression") ||
      syntaxField(node, "computed") === true ||
      propertyName === null
    ) {
      return false;
    }
    const candidates = specs.filter(({ member }) => member === propertyName);
    const tsReceiver =
      candidates.length > 0
        ? services?.esTreeNodeToTSNodeMap.get(syntaxField(node, "object"))
        : undefined;
    if (!tsReceiver) {
      return false;
    }
    const property = checker.getPropertyOfType(
      checker.getTypeAtLocation(tsReceiver),
      propertyName
    );
    return (property?.declarations ?? []).some((declaration) => {
      const owners = declarationOwnerNames(declaration);
      return candidates.some(
        (spec) =>
          owners.has(spec.type) &&
          (!requireSourceMatch ||
            ("source" in spec &&
              declarationSourceMatches(declaration, spec.source)))
      );
    });
  }

  isTrustedImportedTemplateTag(node: unknown): boolean {
    const { sourceCode, safeTemplateTags } = this.#context;
    if (
      !isSyntaxType(node, "Identifier") ||
      safeTemplateTags.imported.length === 0
    ) {
      return false;
    }
    const importDefinition = bindingDefinitions(
      findVariable(sourceCode, node)
    ).find((definition) => fieldOf(definition, "type") === "ImportBinding");
    const source = importSourceSpecifier(importDefinition);
    const imported = importedSpecifierName(importDefinition);
    return safeTemplateTags.imported.some(
      (spec) => spec.module === source && spec.exportName === imported
    );
  }

  isTrustedSqlTemplateTag(node: unknown): boolean {
    if (isSyntaxNode(node) && TEMPLATE_TAG_WRAPPERS.has(node.type)) {
      return this.isTrustedSqlTemplateTag(syntaxField(node, "expression"));
    }
    return (
      this.isTrustedImportedTemplateTag(node) ||
      this.isTrustedMemberOnReceiver(node, true)
    );
  }

  unsafeTrustedRawSqlFragments(template: unknown): readonly unknown[] {
    return syntaxChildren(template, "expressions").filter((expression) =>
      this.#isUnsafeTrustedRawSqlFragment(expression)
    );
  }

  #isUnsafeTrustedRawSqlBuilderCall(node: unknown): boolean {
    const builder = methodReceiver(node, "raw");
    return (
      (this.isTrustedImportedTemplateTag(builder) ||
        this.isTrustedMemberOnReceiver(builder, true)) &&
      syntaxChildren(node, "arguments").some(
        (argument) => staticString(argument) === null
      )
    );
  }

  #isUnsafeTrustedRawSqlFragment(node: unknown): boolean {
    const transparent = transparentRawSqlFragmentExpression(node);
    if (transparent) {
      return this.#isUnsafeTrustedRawSqlFragment(transparent);
    }
    return (
      this.#isUnsafeTrustedRawSqlBuilderCall(node) ||
      unsafeTrustedRawSqlChildren(node).some((child) =>
        this.#isUnsafeTrustedRawSqlFragment(child)
      )
    );
  }
}
