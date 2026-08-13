import { z } from "zod";

const contract = {
  createUser: { body: z.object({ email: z.string() }) },
  updateUser: { body: z.object({ id: z.string(), email: z.string() }) },
};

// Same root, different segments: two different schemas, two real validations.
export function upsert(raw: unknown) {
  const created = contract.createUser.body.parse(raw);
  return contract.updateUser.body.parse(created);
}
