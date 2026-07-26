import { z } from "zod";

export const AsyncTransformSchema = z
  .object({ a: z.string() })
  .transform(async (record) => ({ a: record.a }));
