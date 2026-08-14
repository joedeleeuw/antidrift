import { z } from "zod";

export const runtimeInfoSchema = z
  .object({ commit: z.string().trim().min(1), dirty: z.boolean() })
  .strict();

export const requestSchema = z.object({ id: z.string() }).strict();

export const desktopContract = {
  getRuntimeInfo: {
    requestSchema,
    resultSchema: runtimeInfoSchema,
  },
} as const;
