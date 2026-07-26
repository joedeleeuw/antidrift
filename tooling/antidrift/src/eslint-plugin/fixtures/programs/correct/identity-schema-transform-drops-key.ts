import { z } from "zod";

export const DroppedKeySchema = z
  .object({ a: z.string(), b: z.string() })
  .transform((record) => ({ a: record.a }));
