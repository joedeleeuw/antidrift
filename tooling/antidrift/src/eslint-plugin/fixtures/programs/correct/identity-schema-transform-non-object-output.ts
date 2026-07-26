import { z } from "zod";

export const SelectedFieldSchema = z
  .object({ a: z.string() })
  .transform((record) => record.a);

export const TrimmedStringSchema = z
  .string()
  .transform((value) => value.trim());
