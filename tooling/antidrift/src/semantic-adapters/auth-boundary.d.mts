export interface AuthBoundaryFrame {
  node: unknown;
  paramsAccess: unknown | null;
  sawAuthz: boolean;
}

export interface AuthBoundaryTracker {
  visitors: Record<string, (node: unknown) => void>;
}

export interface AuthBoundaryTrackerOptions {
  authzFunctions?: readonly string[];
  requestParamRoots?: readonly string[];
  onFrameExit?: (frame: AuthBoundaryFrame) => void;
}

export const DEFAULT_AUTHZ_FUNCTIONS: readonly string[];
export const REQUEST_PARAM_ROOTS: readonly string[];

export function callExpressionName(callee: unknown): string | null;

export function isRequestParamsAccess(
  node: unknown,
  requestParamRoots?: readonly string[],
): boolean;

export function isAuthzCall(
  callee: unknown,
  authzFunctions?: readonly string[],
): boolean;

export function createAuthBoundaryTracker(
  options?: AuthBoundaryTrackerOptions,
): AuthBoundaryTracker;
