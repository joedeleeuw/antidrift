import { findVariable } from "../kernel/async-control-flow.ts";
import { isInlineFunction } from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  unwrapExpression,
} from "../kernel/syntax-node.ts";
import {
  isSqlIdentifierContext,
  isSqlInterpolationContext,
  valuesAreSqlDirections,
} from "./sql.ts";
import type { SqlHelperCatalog } from "./sql-helper-catalog.ts";
import type { SqlIdentifierProvenance } from "./sql-identifier-provenance.ts";
import {
  collectReturnArguments,
  isAllowedSqlFragmentJoinSeparator,
  joinSeparator,
  methodReceiver,
  singleReturnExpression,
  sqlPropertyKeyName,
  staticString,
  templateInterpolationParts,
} from "./sql-syntax.ts";

type InterpolationState = {
  readonly safe: boolean;
  readonly previousWasIdentifier: boolean;
};

type InterpolationVerdict = {
  readonly safe: boolean;
  readonly before: string;
  readonly after: string;
};

const PLACEHOLDER_JOIN_SEPARATORS = new Set([" OR ", " AND "]);

const INDEX_ARITHMETIC_OPERATORS = new Set(["+", "*"]);

const UNSAFE_INTERPOLATION = {
  safe: false,
  previousWasIdentifier: false,
} satisfies InterpolationState;

function isIndexArithmeticExpression(
  node: unknown,
  indexName: string
): boolean {
  const unwrapped = unwrapExpression(node);
  if (isSyntaxType(unwrapped, "Identifier")) {
    return identifierName(unwrapped) === indexName;
  }
  if (isSyntaxType(unwrapped, "Literal")) {
    return typeof syntaxField(unwrapped, "value") === "number";
  }
  const operator = syntaxField(unwrapped, "operator");
  return (
    isSyntaxType(unwrapped, "BinaryExpression") &&
    typeof operator === "string" &&
    INDEX_ARITHMETIC_OPERATORS.has(operator) &&
    isIndexArithmeticExpression(syntaxField(unwrapped, "left"), indexName) &&
    isIndexArithmeticExpression(syntaxField(unwrapped, "right"), indexName)
  );
}

function isPostgresPlaceholderTemplate(
  node: unknown,
  indexName: string
): boolean {
  const expressions = syntaxChildren(node, "expressions");
  return (
    isSyntaxType(node, "TemplateLiteral") &&
    expressions.length > 0 &&
    expressions.every((expression, index) => {
      const { before, after } = templateInterpolationParts(node, index);
      return (
        before.endsWith("$") &&
        !/^\d/u.test(after) &&
        isIndexArithmeticExpression(expression, indexName)
      );
    })
  );
}

function mapCallback(joinCall: unknown) {
  const mapCall = methodReceiver(joinCall, "join");
  if (mapCall === null || methodReceiver(mapCall, "map") === null) {
    return null;
  }
  const [callback] = syntaxChildren(mapCall, "arguments");
  return isInlineFunction(callback) ? callback : null;
}

function isStaticFragmentMapJoin(node: unknown): boolean {
  const callback = mapCallback(node);
  return (
    isAllowedSqlFragmentJoinSeparator(joinSeparator(node)) &&
    callback !== null &&
    staticString(syntaxField(callback, "body")) !== null
  );
}

function isPlaceholderSqlFragmentMapJoin(node: unknown): boolean {
  const separator = joinSeparator(node);
  const callback = mapCallback(node);
  const [, indexParameter] = syntaxChildren(callback, "params");
  const indexName = identifierName(indexParameter);
  return (
    separator !== null &&
    PLACEHOLDER_JOIN_SEPARATORS.has(separator) &&
    indexName !== null &&
    isPostgresPlaceholderTemplate(singleReturnExpression(callback), indexName)
  );
}

function intersectPropertySets(
  left: ReadonlySet<string> | null,
  right: ReadonlySet<string>
): ReadonlySet<string> {
  return left
    ? new Set([...left].filter((key) => right.has(key)))
    : new Set(right);
}

export class SqlFragmentProvenance {
  readonly #sourceCode: unknown;
  readonly #catalog: SqlHelperCatalog;
  readonly #identifiers: SqlIdentifierProvenance;
  readonly #fragmentArrays = new WeakSet<object>();
  readonly #fragmentStrings = new WeakSet<object>();
  readonly #fragmentObjectProperties = new WeakMap<
    object,
    ReadonlySet<string>
  >();

  constructor(
    sourceCode: unknown,
    catalog: SqlHelperCatalog,
    identifiers: SqlIdentifierProvenance
  ) {
    this.#sourceCode = sourceCode;
    this.#catalog = catalog;
    this.#identifiers = identifiers;
  }

  recordDeclaration(binding: object, init: unknown, isConst: boolean): void {
    if (this.#isSafeFragmentArray(init)) {
      this.#fragmentArrays.add(binding);
      return;
    }
    if (this.#isSafeFragmentExpression(init)) {
      this.#fragmentStrings.add(binding);
      return;
    }
    const properties =
      this.#objectFragmentProperties(init) ??
      this.#iifeObjectFragmentProperties(init);
    if (properties && isConst) {
      this.#fragmentObjectProperties.set(binding, properties);
    }
  }

  forget(binding: object): void {
    this.#fragmentArrays.delete(binding);
    this.#fragmentStrings.delete(binding);
    this.#fragmentObjectProperties.delete(binding);
  }

  trackCallExpression(call: unknown): void {
    const binding = findVariable(
      this.#sourceCode,
      methodReceiver(call, "push")
    );
    if (
      binding &&
      this.#fragmentArrays.has(binding) &&
      !syntaxChildren(call, "arguments").every((argument) =>
        this.#isSafeFragmentExpression(argument)
      )
    ) {
      this.#fragmentArrays.delete(binding);
    }
  }

  hasUnsafeSqlInterpolation(template: unknown): boolean {
    for (const verdict of this.#interpolationVerdicts(template)) {
      if (
        !verdict.safe &&
        isSqlInterpolationContext(verdict.before, verdict.after)
      ) {
        return true;
      }
    }
    return false;
  }

  *#interpolationVerdicts(
    template: unknown
  ): Generator<InterpolationVerdict, void, undefined> {
    let previousWasIdentifier = false;
    for (const [index, expression] of syntaxChildren(
      template,
      "expressions"
    ).entries()) {
      const { before, after } = templateInterpolationParts(template, index);
      const state = this.#interpolationState(
        expression,
        before,
        after,
        previousWasIdentifier
      );
      yield { safe: state.safe, before, after };
      previousWasIdentifier = state.previousWasIdentifier;
    }
  }

  #interpolationState(
    expression: unknown,
    before: string,
    after: string,
    previousWasIdentifier: boolean
  ): InterpolationState {
    if (this.#isSafeFragmentExpression(expression)) {
      return { safe: true, previousWasIdentifier: false };
    }
    if (
      this.#identifiers.isSafeIdentifierExpression(expression) &&
      isSqlIdentifierContext(before, after)
    ) {
      return { safe: true, previousWasIdentifier: true };
    }
    return valuesAreSqlDirections(this.#identifiers.tokens(expression)) &&
      previousWasIdentifier &&
      /^\s*$/u.test(before)
      ? { safe: true, previousWasIdentifier: false }
      : UNSAFE_INTERPOLATION;
  }

  #isSafeTemplateLiteral(template: unknown): boolean {
    for (const verdict of this.#interpolationVerdicts(template)) {
      if (!verdict.safe) {
        return false;
      }
    }
    return true;
  }

  #isSafeFragmentCall(call: unknown): boolean {
    const summary = this.#catalog.fragmentCallSummary(call);
    const callArguments = syntaxChildren(call, "arguments");
    return (
      summary !== null &&
      callArguments.length === summary.arity &&
      summary.identifierParameterIndexes.every((index) =>
        this.#identifiers.isSafeIdentifierExpression(callArguments[index])
      )
    );
  }

  #isDirectSafeFragmentExpression(node: unknown): boolean {
    return (
      staticString(node) !== null ||
      this.#catalog.escaperCallKind(node) === "string" ||
      this.#isSafeFragmentCall(node) ||
      this.#catalog.isEscaperMapJoin(node, "string") ||
      isStaticFragmentMapJoin(node) ||
      isPlaceholderSqlFragmentMapJoin(node)
    );
  }

  #isSafeFragmentExpression(node: unknown): boolean {
    if (this.#isDirectSafeFragmentExpression(node)) {
      return true;
    }
    if (isSyntaxType(node, "Identifier")) {
      return this.#bindingIn(node, this.#fragmentStrings);
    }
    if (this.#isSafeFragmentMember(node)) {
      return true;
    }
    if (isSyntaxType(node, "ConditionalExpression")) {
      return (
        this.#isSafeFragmentExpression(syntaxField(node, "consequent")) &&
        this.#isSafeFragmentExpression(syntaxField(node, "alternate"))
      );
    }
    if (isSyntaxType(node, "TemplateLiteral")) {
      return this.#isSafeTemplateLiteral(node);
    }
    const joinedArray = methodReceiver(node, "join");
    return (
      joinedArray !== null &&
      isAllowedSqlFragmentJoinSeparator(joinSeparator(node)) &&
      isSyntaxType(joinedArray, "Identifier") &&
      this.#bindingIn(joinedArray, this.#fragmentArrays)
    );
  }

  #bindingIn(identifier: unknown, bindings: WeakSet<object>): boolean {
    const binding = findVariable(this.#sourceCode, identifier);
    return Boolean(binding && bindings.has(binding));
  }

  #isSafeFragmentMember(node: unknown): boolean {
    const receiver = syntaxField(node, "object");
    const propertyName = identifierName(syntaxField(node, "property"));
    if (
      !isSyntaxType(node, "MemberExpression") ||
      syntaxField(node, "computed") === true ||
      !isSyntaxType(receiver, "Identifier") ||
      propertyName === null
    ) {
      return false;
    }
    const binding = findVariable(this.#sourceCode, receiver);
    const properties = binding
      ? this.#fragmentObjectProperties.get(binding)
      : undefined;
    return Boolean(properties?.has(propertyName));
  }

  #isSafeFragmentArray(node: unknown): boolean {
    return (
      isSyntaxType(node, "ArrayExpression") &&
      syntaxChildren(node, "elements").every(
        (element) =>
          isSyntaxNode(element) &&
          element.type !== "SpreadElement" &&
          this.#isSafeFragmentExpression(element)
      )
    );
  }

  #objectFragmentProperties(node: unknown): ReadonlySet<string> | null {
    if (!isSyntaxType(node, "ObjectExpression")) {
      return null;
    }
    const properties = new Set<string>();
    for (const property of syntaxChildren(node, "properties")) {
      const key = isSyntaxType(property, "Property")
        ? sqlPropertyKeyName(syntaxField(property, "key"))
        : "";
      if (
        syntaxField(property, "computed") === true ||
        !key ||
        !this.#isSafeFragmentExpression(syntaxField(property, "value"))
      ) {
        return null;
      }
      properties.add(key);
    }
    return properties;
  }

  #iifeObjectFragmentProperties(node: unknown): ReadonlySet<string> | null {
    const callee = syntaxField(node, "callee");
    const body = syntaxField(callee, "body");
    if (
      !isSyntaxType(node, "CallExpression") ||
      syntaxChildren(node, "arguments").length !== 0 ||
      !isInlineFunction(callee)
    ) {
      return null;
    }
    if (isSyntaxType(body, "ObjectExpression")) {
      return this.#objectFragmentProperties(body);
    }
    const returned: unknown[] = [];
    collectReturnArguments(body, returned);
    let properties: ReadonlySet<string> | null = null;
    for (const argument of returned) {
      const argumentProperties = this.#objectFragmentProperties(argument);
      if (!argumentProperties) {
        return null;
      }
      properties = intersectPropertySets(properties, argumentProperties);
    }
    return properties;
  }
}
