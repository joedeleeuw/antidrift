import {
  fieldOf,
  identifierName,
  isSyntaxType,
} from "../kernel/syntax-node.ts";

export type AuthBoundaryFrame = {
  node: unknown;
  paramsAccess: unknown;
  sawAuthz: boolean;
};

export type AuthBoundaryTrackerOptions = {
  authzFunctions: readonly string[];
  requestParamRoots?: readonly string[];
  onFrameExit?: (frame: AuthBoundaryFrame) => void;
};

export type AuthBoundaryTracker = ReturnType<typeof createAuthBoundaryTracker>;

export const REQUEST_PARAM_ROOTS = Object.freeze([
  "req",
  "request",
  "ctx",
  "context",
  "event",
]);

export function callExpressionName(callee: unknown) {
  return isSyntaxType(callee, "MemberExpression")
    ? identifierName(fieldOf(callee, "property"))
    : identifierName(callee);
}

function invalidStringList(listName: string) {
  return new Error(
    `auth-boundary: ${listName} must be a non-empty string array`
  );
}

function requireStringList(
  listName: string,
  candidate: unknown
): readonly string[] {
  if (!Array.isArray(candidate)) {
    throw invalidStringList(listName);
  }
  const entries: readonly unknown[] = candidate;
  const names = entries.filter((entry) => typeof entry === "string");
  if (
    entries.length === 0 ||
    names.length !== entries.length ||
    names.some((entry) => entry.length === 0)
  ) {
    throw invalidStringList(listName);
  }
  return names;
}

export function isRequestParamsAccess(
  node: unknown,
  requestParamRoots: readonly string[] = REQUEST_PARAM_ROOTS
): boolean {
  const rootName = identifierName(fieldOf(node, "object"));
  return (
    identifierName(fieldOf(node, "property")) === "params" &&
    rootName !== null &&
    new Set(requestParamRoots).has(rootName)
  );
}

export function isAuthzCall(
  callee: unknown,
  authzFunctions: readonly string[]
): boolean {
  const functions = requireStringList("authzFunctions", authzFunctions);
  const name = callExpressionName(callee);
  return name !== null && new Set(functions).has(name);
}

export function createAuthBoundaryTracker(options: AuthBoundaryTrackerOptions) {
  const authzFunctions = requireStringList(
    "authzFunctions",
    options.authzFunctions
  );
  const requestParamRoots = options.requestParamRoots ?? REQUEST_PARAM_ROOTS;
  const { onFrameExit } = options;
  const stack: AuthBoundaryFrame[] = [];
  const enter = (node: unknown): void => {
    stack.push({ node, paramsAccess: null, sawAuthz: false });
  };
  const exit = (): void => {
    const frame = stack.pop();
    if (frame) {
      onFrameExit?.(frame);
    }
  };
  return {
    visitors: {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      MemberExpression(node: unknown): void {
        const frame = stack.at(-1);
        if (frame && isRequestParamsAccess(node, requestParamRoots)) {
          frame.paramsAccess = node;
        }
      },
      CallExpression(node: unknown): void {
        const frame = stack.at(-1);
        if (frame && isAuthzCall(fieldOf(node, "callee"), authzFunctions)) {
          frame.sawAuthz = true;
        }
      },
    },
  };
}
