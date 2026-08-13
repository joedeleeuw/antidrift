import { z } from "zod";

let activeSchema = z.object({ id: z.string() });

// The root is rebound, so the two receivers may name different schemas.
export function refresh(raw: unknown) {
  const value = activeSchema.parse(raw);
  activeSchema = z.object({ id: z.string(), name: z.string() });
  return activeSchema.parse(value);
}
