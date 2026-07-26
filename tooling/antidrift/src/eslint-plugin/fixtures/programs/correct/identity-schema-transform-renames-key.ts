import { z } from "zod";

export const RenamedKeySchema = z
  .object({ a: z.string() })
  .transform((record) => ({ renamed: record.a }));
