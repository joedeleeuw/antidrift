import { z } from "zod";
const ApiUser = z.object({ email: z.string().email(), password: z.string().min(8) });
const DbUser = z.object({ id: z.string(), email: z.string().email() });
// Different schema for the storage shape — a genuine second validation, NOT redundant.
export function create(raw: unknown) {
  const input = ApiUser.parse(raw);
  return DbUser.parse({ id: "generated", email: input.email });
}
