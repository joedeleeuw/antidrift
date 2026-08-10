import { z } from "zod";

export const DestructuredIdentitySchema = z
  .object({ a: z.string(), b: z.number() })
  .transform(({ a, b }) => ({ a, b }));
