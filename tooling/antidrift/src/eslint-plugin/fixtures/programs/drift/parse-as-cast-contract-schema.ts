import { z } from "zod";

const runtimeInfoResultSchema = z.object({
  version: z.string(),
  platform: z.string(),
});
type RuntimeInfoResult = z.infer<typeof runtimeInfoResultSchema>;

const bridgeContract = {
  getRuntimeInfo: {
    channel: "murderbox:runtime-info",
    resultSchema: runtimeInfoResultSchema,
  },
};

export function registerBridge(runtimeInfo: RuntimeInfoResult) {
  return bridgeContract.getRuntimeInfo.resultSchema.parse(runtimeInfo);
}
