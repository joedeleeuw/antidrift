import {
  findVariable,
  getDeclaredVariable,
} from "../kernel/async-control-flow.ts";
import {
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import { SqlFragmentProvenance } from "./sql-fragment-provenance.ts";
import { SqlHelperCatalog } from "./sql-helper-catalog.ts";
import { SqlIdentifierProvenance } from "./sql-identifier-provenance.ts";
import type { SqlProvenanceContext } from "./sql-trusted-sources.ts";
import { SqlTrustedSources } from "./sql-trusted-sources.ts";

const EXPORT_DECLARATION_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
]);

function declaredFunctionCandidates(statement: unknown): readonly unknown[] {
  const declaration =
    isSyntaxNode(statement) && EXPORT_DECLARATION_TYPES.has(statement.type)
      ? syntaxField(statement, "declaration")
      : statement;
  if (isSyntaxType(declaration, "FunctionDeclaration")) {
    return [declaration];
  }
  return isSyntaxType(declaration, "VariableDeclaration")
    ? syntaxChildren(declaration, "declarations")
    : [];
}

function assignedIdentifier(assignment: unknown): unknown {
  const target = syntaxField(assignment, "left");
  if (isSyntaxType(target, "Identifier")) {
    return target;
  }
  const receiver = syntaxField(target, "object");
  return isSyntaxType(target, "MemberExpression") &&
    isSyntaxType(receiver, "Identifier")
    ? receiver
    : null;
}

export class SqlProvenanceTracker {
  readonly trustedSources: SqlTrustedSources;
  readonly identifiers: SqlIdentifierProvenance;
  readonly fragments: SqlFragmentProvenance;
  readonly #sourceCode: unknown;
  readonly #catalog: SqlHelperCatalog;

  constructor(context: SqlProvenanceContext) {
    this.#sourceCode = context.sourceCode;
    this.#catalog = new SqlHelperCatalog(context);
    this.trustedSources = new SqlTrustedSources(context);
    this.identifiers = new SqlIdentifierProvenance(
      context.sourceCode,
      this.#catalog,
      this.trustedSources
    );
    this.fragments = new SqlFragmentProvenance(
      context.sourceCode,
      this.#catalog,
      this.identifiers
    );
  }

  scanProgram(program: unknown): void {
    const candidates = syntaxChildren(program, "body").flatMap(
      declaredFunctionCandidates
    );
    for (const candidate of candidates) {
      this.#catalog.markEscaperFunction(candidate);
    }
    for (const candidate of candidates) {
      this.#catalog.markFragmentFunction(candidate);
    }
  }

  trackVariableDeclarator(declarator: unknown): void {
    this.#catalog.markEscaperFunction(declarator);
    this.#catalog.markFragmentFunction(declarator);
    const binding = getDeclaredVariable(this.#sourceCode, declarator);
    if (!binding) {
      return;
    }
    const init = syntaxField(declarator, "init");
    const isConst =
      syntaxField(syntaxField(declarator, "parent"), "kind") === "const";
    this.identifiers.recordDeclaration(binding, init, isConst);
    this.fragments.recordDeclaration(binding, init, isConst);
  }

  trackAssignment(assignment: unknown): void {
    const binding = findVariable(
      this.#sourceCode,
      assignedIdentifier(assignment)
    );
    if (binding) {
      this.fragments.forget(binding);
      this.identifiers.forget(binding);
    }
  }
}
