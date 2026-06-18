import type * as ts from "typescript";

export type TypeScriptParserServices = {
  esTreeNodeToTSNodeMap: {
    get(node: unknown): ts.Node | undefined;
  };
};

export interface ObjectEntriesCallbackProbe {
  callback: unknown;
  paramNames: Set<string>;
  valueBindings: unknown[];
}

export interface TypePredicateParts {
  paramName: string;
  targetTypeNode: unknown;
}

export const BROAD_INPUT_ARRAY_TRANSFORM_METHODS: ReadonlySet<
  "map" | "flatMap" | "reduce"
>;

export function unwrapExpression(expression: unknown): unknown;

export function assignmentTarget(node: unknown): unknown;

export function collectBindingNames(node: unknown, names: Set<string>): void;

export function collectObjectPatternBindingNames(
  pattern: unknown,
  names: Set<string>,
): void;

export function collectBindingIdentifiers(
  node: unknown,
  identifiers: unknown[],
): void;

export function memberExpressionRootName(expression: unknown): string | null;

export function walkNode(node: unknown, visit: (node: unknown) => void): void;

export function isNullishLiteral(node: unknown): boolean;

export function hasParamRoot(
  expression: unknown,
  paramNames: ReadonlySet<string>,
): boolean;

export function isTypeofObjectProbe(
  node: unknown,
  paramNames: ReadonlySet<string>,
): boolean;

export function countShapeProbesIn(
  node: unknown,
  paramNames: ReadonlySet<string>,
): number;

export function isObjectEntriesCall(node: unknown): boolean;

export function objectEntriesValueBindings(
  callback: unknown,
  methodName: string,
): unknown[];

export function objectEntriesCallbackProbe(
  node: unknown,
): ObjectEntriesCallbackProbe | null;

export function isBroadShapeProbeInputType(
  checker: ts.TypeChecker,
  type: ts.Type | null | undefined,
  seen?: Set<ts.Type>,
): boolean;

export function hasBroadObjectEntriesValue(
  probe: ObjectEntriesCallbackProbe,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
): boolean;

export function typePredicateParts(fn: unknown): TypePredicateParts | null;

export function functionParameterByName(
  fn: unknown,
  name: string,
): unknown | null;

export function isBroadPredicateInputType(
  checker: ts.TypeChecker,
  type: ts.Type | null | undefined,
): boolean;

export function isNamedTypeReference(typeNode: unknown): boolean;

export function isAppeasementCastSourceType(
  type: ts.Type | null | undefined,
): boolean;

export function isAppeasementCastTargetType(
  type: ts.Type | null | undefined,
): boolean;

export function isAppeasementContractCast(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
): boolean;

export function isPredicateObjectContract(
  type: ts.Type | null | undefined,
): boolean;

export function requiredTypeProps(
  checker: ts.TypeChecker,
  type: ts.Type,
): Set<string>;

export function staticPropertyName(node: unknown): string | null;

export function memberExpressionPropertyName(node: unknown): string | null;

export function objectHasOwnPropertyName(
  node: unknown,
  paramNames: ReadonlySet<string>,
): string | null;

export function directAliasName(
  node: unknown,
  paramNames: ReadonlySet<string>,
): string | null;

export function predicateValueNames(
  node: unknown,
  paramName: string,
): Set<string>;

export function destructuredTargetPropertyAliases(
  node: unknown,
  paramNames: ReadonlySet<string>,
  targetProps: ReadonlySet<string>,
): Map<string, string>;

export function isBindingIdentifier(node: unknown): boolean;

export function checkedTargetProperties(
  node: unknown,
  paramName: string,
  targetProps: ReadonlySet<string>,
): Set<string>;

export function callUsesPredicateParam(
  node: unknown,
  paramName: string,
): boolean;

export function hasValidatorDelegation(
  node: unknown,
  paramName: string,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
): boolean;
