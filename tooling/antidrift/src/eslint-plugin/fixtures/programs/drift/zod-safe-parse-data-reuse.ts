import { z } from "zod";

const sessionSchema = z.object({ id: z.string(), token: z.string() });

export function restore(raw: unknown) {
  const result = sessionSchema.safeParse(raw);
  if (!result.success) return null;
  // redundant: result.data is this schema's own output
  return sessionSchema.parse(result.data);
}

export function restoreDestructured(raw: unknown) {
  const { success, data } = sessionSchema.safeParse(raw);
  if (!success) return null;
  // redundant: the destructured data binding carries the same provenance
  return sessionSchema.parse(data);
}
