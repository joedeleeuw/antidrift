import type * as ts from "typescript";

export type TypeScriptParserServices = {
  esTreeNodeToTSNodeMap: {
    get(node: unknown): ts.Node | undefined;
  };
};

export type ZodParseMethod = "parse" | "parseAsync";
export type ZodValidationMethod =
  | ZodParseMethod
  | "safeParse"
  | "safeParseAsync";

export interface ZodParseCallParts {
  callee: unknown;
  tsCall: ts.CallExpression;
  arg: unknown;
  method: ZodValidationMethod;
  /** False for the safe variants, whose result is a wrapper rather than the schema output. */
  returnsSchemaOutput: boolean;
}

export const ZOD_PARSE_METHODS: ReadonlySet<ZodParseMethod>;
export const ZOD_VALIDATION_METHODS: ReadonlySet<ZodValidationMethod>;
export const ZOD_THROW_ASSERTION_MATCHERS: ReadonlySet<
  "toThrow" | "toThrowError"
>;

export function isZodMethod(
  checker: ts.TypeChecker,
  tsNameNode: ts.Node | null | undefined,
): boolean;

export function isThrowAssertionCallbackParse(node: unknown): boolean;

export function zodParseCallParts(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
  methods?: ReadonlySet<string>,
): ZodParseCallParts | null;

export function isAwaitedCallInitializer(node: unknown): boolean;

export function isCallResultExpression(node: unknown): boolean;

export function isZodParseExpression(
  node: unknown,
  services: TypeScriptParserServices,
  checker: ts.TypeChecker,
): boolean;

export function parsedCallResultMatchesSchemaOutput(
  checker: ts.TypeChecker,
  services: TypeScriptParserServices,
  tsCall: ts.Node,
  arg: unknown,
): boolean;

export function recordParsedConst(
  node: unknown,
  schemaSym: ts.Symbol | undefined,
  symbolOf: (node: unknown) => ts.Symbol | undefined,
  validatedBy: Map<ts.Symbol, ts.Symbol>,
): void;
