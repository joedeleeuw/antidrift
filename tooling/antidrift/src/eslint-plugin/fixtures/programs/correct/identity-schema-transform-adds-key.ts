import { z } from "zod";

declare function nowIso(): string;

export const AddedKeySchema = z
  .object({ a: z.string() })
  .transform((record) => ({ a: record.a, createdAt: nowIso() }));
