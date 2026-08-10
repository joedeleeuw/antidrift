import { z } from "zod";

export const IdentityRecordSchema = z
  .object({ a: z.string(), b: z.number() })
  .transform((record) => ({ a: record.a, b: record.b }));
