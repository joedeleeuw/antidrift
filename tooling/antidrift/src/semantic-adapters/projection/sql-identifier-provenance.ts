import { findVariable } from "../kernel/async-control-flow.ts";
import {
  fieldOf,
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  unwrapExpression,
} from "../kernel/syntax-node.ts";
import { bindingDefinitions } from "../kernel/syntax-scope.ts";
import {
  isSqlDirectionToken,
  isSqlIdentifierToken,
  templateStaticPartsAreSqlIdentifierSafe,
  valuesAreSqlIdentifiers,
} from "./sql.ts";
import type { SqlHelperCatalog } from "./sql-helper-catalog.ts";
import {
  methodReceiver,
  sqlPropertyKeyName,
  statementExits,
  staticString,
} from "./sql-syntax.ts";
import type { SqlTrustedSources } from "./sql-trusted-sources.ts";

type SqlTokens = ReadonlySet<string>;

type CharacterClassRule = {
  readonly ranges: ReadonlySet<string>;
  readonly character: RegExp;
};

const LEADING_IDENTIFIER_CLASS = {
  ranges: new Set(["a-z", "A-Z"]),
  character: /^[A-Za-z_]$/u,
} satisfies CharacterClassRule;

const TRAILING_IDENTIFIER_CLASS = {
  ranges: new Set(["a-z", "A-Z", "0-9"]),
  character: /^\w$/u,
} satisfies CharacterClassRule;

const IDENTIFIER_REGEX_SOURCE = /^\^\[([^\]]+)\]\[([^\]]+)\]\*\$$/u;

const CASE_TRANSFORMS = new Map<string, (token: string) => string>([
  ["toUpperCase", (token) => token.toUpperCase()],
  ["toLowerCase", (token) => token.toLowerCase()],
]);

const CLASS_TYPES = new Set(["ClassDeclaration", "ClassExpression"]);

function characterClassAllows(
  characterClass: string,
  rule: CharacterClassRule
): boolean {
  let position = 0;
  while (position < characterClass.length) {
    const character = characterClass[position] ?? "";
    const rangeEnd = characterClass[position + 2];
    if (characterClass[position + 1] === "-" && rangeEnd) {
      if (!rule.ranges.has(`${character}-${rangeEnd}`)) {
        return false;
      }
      position += 3;
    } else {
      if (!rule.character.test(character)) {
        return false;
      }
      position += 1;
    }
  }
  return true;
}

function isSqlIdentifierRegexLiteral(node: unknown): boolean {
  const regex = isSyntaxType(node, "Literal")
    ? syntaxField(node, "regex")
    : undefined;
  const pattern = fieldOf(regex, "pattern");
  const match = IDENTIFIER_REGEX_SOURCE.exec(
    regex && typeof pattern === "string" ? pattern : ""
  );
  if (!match) {
    return false;
  }
  const [, leading = "", trailing = ""] = match;
  return (
    characterClassAllows(leading, LEADING_IDENTIFIER_CLASS) &&
    characterClassAllows(trailing, TRAILING_IDENTIFIER_CLASS)
  );
}

function variableTypeNode(binding: unknown): unknown {
  const [definition] = bindingDefinitions(binding);
  const declarationNode = fieldOf(definition, "node");
  return (
    syntaxField(
      syntaxField(fieldOf(definition, "name"), "typeAnnotation"),
      "typeAnnotation"
    ) ??
    syntaxField(
      syntaxField(declarationNode, "typeAnnotation"),
      "typeAnnotation"
    ) ??
    syntaxField(
      syntaxField(syntaxField(declarationNode, "id"), "typeAnnotation"),
      "typeAnnotation"
    ) ??
    null
  );
}

function sqlStringTokensFromType(typeNode: unknown): SqlTokens | null {
  if (isSyntaxType(typeNode, "TSUnionType")) {
    const tokens = new Set<string>();
    for (const part of syntaxChildren(typeNode, "types")) {
      const partTokens = sqlStringTokensFromType(part);
      if (!partTokens) {
        return null;
      }
      for (const token of partTokens) {
        tokens.add(token);
      }
    }
    return tokens;
  }
  const literal = syntaxField(typeNode, "literal");
  const literalText = syntaxField(literal, "value");
  return isSyntaxType(typeNode, "TSLiteralType") &&
    isSyntaxType(literal, "Literal") &&
    typeof literalText === "string"
    ? new Set([literalText])
    : null;
}

function sqlTypePropertyTokens(
  typeNode: unknown,
  propertyName: string
): SqlTokens | null {
  if (!isSyntaxType(typeNode, "TSTypeLiteral")) {
    return null;
  }
  const member = syntaxChildren(typeNode, "members").find(
    (candidate) =>
      isSyntaxType(candidate, "TSPropertySignature") &&
      sqlPropertyKeyName(syntaxField(candidate, "key")) === propertyName
  );
  return member === undefined
    ? null
    : sqlStringTokensFromType(
        syntaxField(syntaxField(member, "typeAnnotation"), "typeAnnotation")
      );
}

function unionTokens(
  left: SqlTokens | null,
  right: SqlTokens | null
): SqlTokens | null {
  return left && right ? new Set([...left, ...right]) : null;
}

function objectLiteralIdentifierTokens(node: unknown): SqlTokens | null {
  if (!isSyntaxType(node, "ObjectExpression")) {
    return null;
  }
  const tokens = new Set<string>();
  for (const property of syntaxChildren(node, "properties")) {
    const token = isSyntaxType(property, "Property")
      ? staticString(syntaxField(property, "value"))
      : null;
    if (!token || !isSqlIdentifierToken(token)) {
      return null;
    }
    tokens.add(token);
  }
  return tokens;
}

function classMemberKey(node: unknown): string | null {
  return isSyntaxType(node, "MemberExpression") &&
    syntaxField(node, "computed") !== true &&
    isSyntaxType(syntaxField(node, "object"), "ThisExpression")
    ? identifierName(syntaxField(node, "property"))
    : null;
}

function enclosingClass(node: unknown): object | null {
  let current = syntaxField(node, "parent");
  while (isSyntaxNode(current)) {
    if (CLASS_TYPES.has(current.type)) {
      return current;
    }
    current = syntaxField(current, "parent");
  }
  return null;
}

function isIdentifierOrDirectionToken(token: string): boolean {
  return isSqlIdentifierToken(token) || isSqlDirectionToken(token);
}

export class SqlIdentifierProvenance {
  readonly #sourceCode: unknown;
  readonly #catalog: SqlHelperCatalog;
  readonly #trustedSources: SqlTrustedSources;
  readonly #tokensByBinding = new WeakMap<object, SqlTokens>();
  readonly #objectTokensByBinding = new WeakMap<object, SqlTokens>();
  readonly #dynamicIdentifierBindings = new WeakSet<object>();
  readonly #dynamicMembersByClass = new WeakMap<object, Set<string>>();
  readonly #identifierRegexBindings = new WeakSet<object>();

  constructor(
    sourceCode: unknown,
    catalog: SqlHelperCatalog,
    trustedSources: SqlTrustedSources
  ) {
    this.#sourceCode = sourceCode;
    this.#catalog = catalog;
    this.#trustedSources = trustedSources;
  }

  recordDeclaration(binding: object, init: unknown, isConst: boolean): void {
    if (isSqlIdentifierRegexLiteral(init)) {
      this.#identifierRegexBindings.add(binding);
    }
    const objectTokens = objectLiteralIdentifierTokens(init);
    const tokens = this.tokens(init);
    if (objectTokens && isConst) {
      this.#objectTokensByBinding.set(binding, objectTokens);
    }
    if (tokens && [...tokens].every(isIdentifierOrDirectionToken)) {
      this.#tokensByBinding.set(binding, tokens);
    }
    if (this.isSafeIdentifierExpression(init)) {
      this.#dynamicIdentifierBindings.add(binding);
    }
  }

  forget(binding: object): void {
    this.#tokensByBinding.delete(binding);
    this.#objectTokensByBinding.delete(binding);
    this.#dynamicIdentifierBindings.delete(binding);
  }

  trackIfStatement(statement: unknown): void {
    const binding = findVariable(
      this.#sourceCode,
      this.#guardedIdentifier(statement)
    );
    if (binding) {
      this.#dynamicIdentifierBindings.add(binding);
    }
  }

  trackMemberAssignmentExit(assignment: unknown): void {
    const target = syntaxField(assignment, "left");
    if (!isSyntaxType(target, "MemberExpression")) {
      return;
    }
    const isSafe = this.isSafeIdentifierExpression(
      syntaxField(assignment, "right")
    );
    const key = classMemberKey(target);
    const classNode = key === null ? null : enclosingClass(target);
    if (key === null || !classNode) {
      return;
    }
    if (isSafe) {
      this.#classMembers(classNode).add(key);
    } else {
      this.#dynamicMembersByClass.get(classNode)?.delete(key);
    }
  }

  tokens(node: unknown): SqlTokens | null {
    const literalText = staticString(node);
    if (literalText !== null) {
      return new Set([literalText]);
    }
    const unwrapped = unwrapExpression(node);
    if (unwrapped !== node) {
      return this.tokens(unwrapped);
    }
    if (isSyntaxType(node, "Identifier")) {
      const binding = findVariable(this.#sourceCode, node);
      return binding ? (this.#tokensByBinding.get(binding) ?? null) : null;
    }
    if (isSyntaxType(node, "MemberExpression")) {
      return this.#memberTokens(node);
    }
    const operator = syntaxField(node, "operator");
    if (
      isSyntaxType(node, "LogicalExpression") &&
      (operator === "??" || operator === "||")
    ) {
      return unionTokens(
        this.tokens(syntaxField(node, "left")),
        this.tokens(syntaxField(node, "right"))
      );
    }
    if (isSyntaxType(node, "ConditionalExpression")) {
      return unionTokens(
        this.tokens(syntaxField(node, "consequent")),
        this.tokens(syntaxField(node, "alternate"))
      );
    }
    return isSyntaxType(node, "CallExpression")
      ? this.#transformedCallTokens(node)
      : null;
  }

  isSafeIdentifierExpression(node: unknown): boolean {
    return (
      this.#catalog.escaperCallKind(node) === "identifier" ||
      this.#catalog.isEscaperMapJoin(node, "identifier") ||
      valuesAreSqlIdentifiers(this.tokens(node)) ||
      this.#isDynamicIdentifierVariable(node) ||
      this.#trustedSources.isTrustedMemberOnReceiver(node, false) ||
      (isSyntaxType(node, "MemberExpression") &&
        this.#isDynamicIdentifierMember(node)) ||
      this.#isSafeDynamicIdentifierTemplate(node)
    );
  }

  #memberTokens(member: unknown): SqlTokens | null {
    const receiver = syntaxField(member, "object");
    if (
      syntaxField(member, "computed") === true &&
      isSyntaxType(receiver, "Identifier")
    ) {
      const binding = findVariable(this.#sourceCode, receiver);
      return binding
        ? (this.#objectTokensByBinding.get(binding) ?? null)
        : null;
    }
    const propertyName = identifierName(syntaxField(member, "property"));
    if (
      syntaxField(member, "computed") === true ||
      !isSyntaxType(receiver, "Identifier") ||
      !propertyName
    ) {
      return null;
    }
    return sqlTypePropertyTokens(
      variableTypeNode(findVariable(this.#sourceCode, receiver)),
      propertyName
    );
  }

  #transformedCallTokens(call: unknown): SqlTokens | null {
    const callee = syntaxField(call, "callee");
    const method = identifierName(syntaxField(callee, "property"));
    if (
      syntaxChildren(call, "arguments").length > 0 ||
      !isSyntaxType(callee, "MemberExpression") ||
      syntaxField(callee, "computed") === true ||
      method === null
    ) {
      return null;
    }
    const sourceTokens = this.tokens(syntaxField(callee, "object"));
    const transform = CASE_TRANSFORMS.get(method);
    return sourceTokens && transform
      ? new Set([...sourceTokens].map(transform))
      : null;
  }

  #isDynamicIdentifierVariable(node: unknown): boolean {
    const binding = findVariable(this.#sourceCode, node);
    return Boolean(binding && this.#dynamicIdentifierBindings.has(binding));
  }

  #isDynamicIdentifierMember(member: unknown): boolean {
    const key = classMemberKey(member);
    const classNode = key === null ? null : enclosingClass(member);
    return Boolean(
      key !== null &&
      classNode &&
      this.#dynamicMembersByClass.get(classNode)?.has(key)
    );
  }

  #isSafeDynamicIdentifierTemplate(node: unknown): boolean {
    const expressions = syntaxChildren(node, "expressions");
    return (
      isSyntaxType(node, "TemplateLiteral") &&
      expressions.length > 0 &&
      templateStaticPartsAreSqlIdentifierSafe(node) &&
      expressions.every((expression) =>
        this.isSafeIdentifierExpression(expression)
      )
    );
  }

  #classMembers(classNode: object): Set<string> {
    const existing = this.#dynamicMembersByClass.get(classNode);
    if (existing) {
      return existing;
    }
    const members = new Set<string>();
    this.#dynamicMembersByClass.set(classNode, members);
    return members;
  }

  #guardedIdentifier(statement: unknown) {
    const test = syntaxField(statement, "test");
    const call =
      isSyntaxType(test, "UnaryExpression") &&
      syntaxField(test, "operator") === "!"
        ? syntaxField(test, "argument")
        : null;
    const regexBinding = findVariable(
      this.#sourceCode,
      methodReceiver(call, "test")
    );
    if (
      !statementExits(syntaxField(statement, "consequent")) ||
      !regexBinding ||
      !this.#identifierRegexBindings.has(regexBinding)
    ) {
      return null;
    }
    const [argument] = syntaxChildren(call, "arguments");
    return isSyntaxType(argument, "Identifier") ? argument : null;
  }
}
