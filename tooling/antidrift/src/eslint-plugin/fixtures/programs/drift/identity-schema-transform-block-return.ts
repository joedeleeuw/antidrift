import { z } from "zod";

export const BlockIdentitySchema = z
  .object({ a: z.string() })
  .transform((record) => {
    return { a: record.a };
  });
