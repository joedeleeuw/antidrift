import { z } from "zod";

export const FunctionIdentitySchema = z
  .object({ a: z.string() })
  .transform(function identity(record) {
    return { a: record.a };
  });
