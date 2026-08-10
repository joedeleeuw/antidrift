import { z } from "zod";

export const ReorderedIdentitySchema = z
  .object({ a: z.string(), b: z.number() })
  .transform((record) => ({ b: record.b, a: record.a }));
