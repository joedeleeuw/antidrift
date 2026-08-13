import { z } from "zod";

const userSchema = z.object({ id: z.string(), name: z.string() });

declare const raw: unknown;
const user = userSchema.parse(raw);

// bump() is declared below, but hoisting means it runs here and mutates the
// value. A source-order window cannot see that, so the call itself is the hazard.
export function persist() {
  bump();
  return userSchema.parse(user);
}

function bump() {
  user.id = "rewritten";
}
