import { z } from "zod";

const runtimeInfoSchema = z.object({
  version: z.string(),
  platform: z.string(),
});

const bridgeContract = {
  getRuntimeInfo: {
    channel: "murderbox:runtime-info",
    resultSchema: runtimeInfoSchema,
  },
};

export function relay(raw: unknown) {
  const info = bridgeContract.getRuntimeInfo.resultSchema.parse(raw);
  // redundant: the contract seam holds one schema, and it already ran
  return bridgeContract.getRuntimeInfo.resultSchema.parse(info);
}
