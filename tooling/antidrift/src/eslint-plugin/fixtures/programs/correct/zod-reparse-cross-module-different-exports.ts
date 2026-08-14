import {
  desktopContract,
  requestSchema,
} from "../support/desktop-contract";

// Two different exports of one module never unify: identity is the terminal
// slot after resolution, not the module specifier.
export function relay(raw: unknown) {
  const request = requestSchema.parse(raw);
  return desktopContract.getRuntimeInfo.resultSchema.parse(request);
}
