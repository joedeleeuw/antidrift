import { z } from "zod";
const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
export function handle(raw: unknown) {
  const user = UserSchema.parse(raw);     // legitimate first parse at the boundary
  if (user.id === "") throw new Error("bad id");
  return UserSchema.parse(user);          // redundant: user already validated by UserSchema
}
