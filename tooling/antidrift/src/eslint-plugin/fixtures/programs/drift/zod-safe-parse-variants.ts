import { z } from "zod";

const UserSchema = z.object({ id: z.string(), name: z.string() });
type User = z.infer<typeof UserSchema>;

// no-parse-as-cast: the parameter is already declared as the schema output.
export function persist(user: User) {
  return UserSchema.safeParse(user);
}

// no-redundant-zod-parse: this value was already validated by the same schema.
export function recheck() {
  const user = UserSchema.parse({ id: "1", name: "ada" });
  return UserSchema.safeParse(user);
}
