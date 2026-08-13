import { z } from "zod";

const runtimeInfoSchema = z.object({ version: z.string() });

const contract = {
  getRuntimeInfo: { channel: "runtime-info", resultSchema: runtimeInfoSchema },
} as const;

export function relay(raw: unknown) {
  const info = runtimeInfoSchema.parse(raw);
  const method = contract.getRuntimeInfo;
  // redundant: the contract member resolves in this file to the same binding
  return method.resultSchema.parse(info);
}
