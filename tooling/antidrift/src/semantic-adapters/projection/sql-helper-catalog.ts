import type ts from "typescript";

import {
  findVariable,
  getDeclaredVariable,
} from "../kernel/async-control-flow.ts";
import {
  getFunctionNode,
  isFunctionLike,
  isInlineFunction,
} from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import { aliasTarget } from "../provenance/symbol-provenance.ts";
import type { SqlEscaperKind } from "./sql-escaper.ts";
import {
  sqlEscaperFunctionKind,
  tsSqlEscaperDeclarationKind,
} from "./sql-escaper.ts";
import {
  isAllowedSqlFragmentJoinSeparator,
  isUnquotedSqlInterpolation,
  joinSeparator,
  methodReceiver,
  singleReturnExpression,
  staticString,
  templateInterpolationParts,
} from "./sql-syntax.ts";
import type { SqlProvenanceContext } from "./sql-trusted-sources.ts";

export type SqlFragmentFunctionSummary = {
  readonly arity: number;
  readonly identifierParameterIndexes: readonly number[];
};

const ESCAPER_JOIN_SEPARATORS = {
  identifier: new Set(["."]),
  string: new Set([",", ", "]),
} satisfies { [Kind in SqlEscaperKind]: ReadonlySet<string> };

class FragmentFunctionScan {
  readonly identifierParameters = new Set<string>();
  readonly #catalog: SqlHelperCatalog;
  readonly #parameterNames: ReadonlySet<string>;

  constructor(catalog: SqlHelperCatalog, parameterNames: ReadonlySet<string>) {
    this.#catalog = catalog;
    this.#parameterNames = parameterNames;
  }

  isSafeExpression(expression: unknown): boolean {
    if (
      staticString(expression) !== null ||
      this.#catalog.escaperCallKind(expression) === "string" ||
      this.#catalog.isEscaperMapJoin(expression, "string")
    ) {
      return true;
    }
    if (isSyntaxType(expression, "TemplateLiteral")) {
      return this.#isSafeTemplate(expression);
    }
    return (
      isSyntaxType(expression, "CallExpression") &&
      this.#isSafeMapJoin(expression)
    );
  }

  #isSafeTemplate(template: unknown): boolean {
    const expressions = syntaxChildren(template, "expressions");
    return expressions.every((expression, index) => {
      const parameterName = identifierName(expression);
      if (parameterName === null || !this.#parameterNames.has(parameterName)) {
        return this.isSafeExpression(expression);
      }
      const { before, after } = templateInterpolationParts(template, index);
      if (!isUnquotedSqlInterpolation(before, after)) {
        return false;
      }
      this.identifierParameters.add(parameterName);
      return true;
    });
  }

  #isSafeMapJoin(call: unknown): boolean {
    const mapCall = methodReceiver(call, "join");
    const separator = joinSeparator(call);
    if (
      mapCall === null ||
      (!isAllowedSqlFragmentJoinSeparator(separator) && separator !== "\n") ||
      methodReceiver(mapCall, "map") === null
    ) {
      return false;
    }
    const [callback] = syntaxChildren(mapCall, "arguments");
    return (
      isInlineFunction(callback) &&
      this.isSafeExpression(singleReturnExpression(callback))
    );
  }
}

export class SqlHelperCatalog {
  readonly #context: Pick<
    SqlProvenanceContext,
    "sourceCode" | "services" | "checker"
  >;
  readonly #escaperFunctions = new WeakMap<object, SqlEscaperKind>();
  readonly #importedEscaperDeclarations = new WeakMap<
    ts.Declaration,
    SqlEscaperKind | null
  >();
  readonly #fragmentFunctions = new WeakMap<
    object,
    SqlFragmentFunctionSummary
  >();

  constructor(
    context: Pick<SqlProvenanceContext, "sourceCode" | "services" | "checker">
  ) {
    this.#context = context;
  }

  markEscaperFunction(declaration: unknown): void {
    const kind = sqlEscaperFunctionKind(getFunctionNode(declaration));
    if (!kind) {
      return;
    }
    const binding = getDeclaredVariable(this.#context.sourceCode, declaration);
    if (binding) {
      this.#escaperFunctions.set(binding, kind);
    }
  }

  markFragmentFunction(declaration: unknown): void {
    const summary = this.#fragmentFunctionSummary(declaration);
    if (!summary) {
      return;
    }
    const binding = getDeclaredVariable(this.#context.sourceCode, declaration);
    if (binding) {
      this.#fragmentFunctions.set(binding, summary);
    }
  }

  escaperCallKind(node: unknown): SqlEscaperKind | null {
    const callee = syntaxField(node, "callee");
    if (
      !isSyntaxType(node, "CallExpression") ||
      syntaxChildren(node, "arguments").length !== 1 ||
      !isSyntaxType(callee, "Identifier")
    ) {
      return null;
    }
    return this.#identifierEscaperKind(callee);
  }

  isEscaperMapJoin(node: unknown, kind: SqlEscaperKind): boolean {
    const mapCall = methodReceiver(node, "join");
    const separator = joinSeparator(node);
    if (
      mapCall === null ||
      separator === null ||
      !ESCAPER_JOIN_SEPARATORS[kind].has(separator) ||
      methodReceiver(mapCall, "map") === null
    ) {
      return false;
    }
    const [callback] = syntaxChildren(mapCall, "arguments");
    return this.#escaperCallbackKind(callback) === kind;
  }

  fragmentCallSummary(node: unknown): SqlFragmentFunctionSummary | null {
    const callee = syntaxField(node, "callee");
    if (!isSyntaxType(node, "CallExpression")) {
      return null;
    }
    const binding = findVariable(this.#context.sourceCode, callee);
    return binding ? (this.#fragmentFunctions.get(binding) ?? null) : null;
  }

  #escaperCallbackKind(callback: unknown): SqlEscaperKind | null {
    if (isSyntaxType(callback, "Identifier")) {
      return this.#identifierEscaperKind(callback);
    }
    return sqlEscaperFunctionKind(callback);
  }

  #identifierEscaperKind(identifier: unknown): SqlEscaperKind | null {
    const binding = findVariable(this.#context.sourceCode, identifier);
    return (
      (binding ? this.#escaperFunctions.get(binding) : undefined) ??
      this.#importedEscaperKind(identifier)
    );
  }

  #importedEscaperKind(identifier: unknown): SqlEscaperKind | null {
    const { checker, services } = this.#context;
    if (!checker || !services || !isSyntaxType(identifier, "Identifier")) {
      return null;
    }
    const tsNode = services.esTreeNodeToTSNodeMap.get(identifier);
    const symbol = tsNode && checker.getSymbolAtLocation(tsNode);
    for (const declaration of aliasTarget(checker, symbol)?.declarations ??
      []) {
      const cached = this.#importedEscaperDeclarations.get(declaration);
      if (cached !== undefined) {
        return cached;
      }
      const kind = tsSqlEscaperDeclarationKind(declaration);
      this.#importedEscaperDeclarations.set(declaration, kind);
      if (kind) {
        return kind;
      }
    }
    return null;
  }

  #fragmentFunctionSummary(
    declaration: unknown
  ): SqlFragmentFunctionSummary | null {
    const functionNode = getFunctionNode(declaration);
    const declaredParameters = syntaxChildren(functionNode, "params");
    const parameterNames = declaredParameters.map((parameter) =>
      identifierName(parameter)
    );
    if (
      !isFunctionLike(functionNode) ||
      parameterNames.some((parameterName) => parameterName === null)
    ) {
      return null;
    }
    const scan = new FragmentFunctionScan(
      this,
      new Set(parameterNames.filter((parameterName) => parameterName !== null))
    );
    if (!scan.isSafeExpression(singleReturnExpression(functionNode))) {
      return null;
    }
    return {
      arity: declaredParameters.length,
      identifierParameterIndexes: parameterNames.flatMap(
        (parameterName, index) =>
          parameterName !== null && scan.identifierParameters.has(parameterName)
            ? [index]
            : []
      ),
    };
  }
}
