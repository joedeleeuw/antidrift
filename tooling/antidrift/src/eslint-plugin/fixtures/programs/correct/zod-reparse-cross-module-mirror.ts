import { z } from "zod";

import { userContract } from "./user-contract";

const mirroredUserSchema = z.object({ id: z.string(), email: z.string() });

// A local mirror of an imported contract schema is never unified by inference:
// same root binding or nothing.
export function sync(raw: unknown) {
  const user = userContract.getUser.responses[200].parse(raw);
  return mirroredUserSchema.parse(user);
}
