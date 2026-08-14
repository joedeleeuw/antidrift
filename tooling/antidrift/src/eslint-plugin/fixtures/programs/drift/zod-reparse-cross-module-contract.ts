import {
  desktopContract,
  runtimeInfoSchema,
} from "../support/desktop-contract";

const method = desktopContract.getRuntimeInfo;

// The contract slot and the direct import are the same schema object: the slot
// resolves through the defining module to the same terminal binding.
export function bridge(raw: unknown) {
  const parsed = runtimeInfoSchema.parse(raw);
  return method.resultSchema.parse(parsed);
}
