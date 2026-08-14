import { z } from "zod";

const apiUser = z.object({ email: z.string() });
const dbUser = z.object({ id: z.string(), email: z.string() });

// A different schema's safeParse result is a genuine second validation.
export function store(raw: unknown) {
  const result = apiUser.safeParse(raw);
  if (!result.success) return null;
  return dbUser.parse(result.data);
}
