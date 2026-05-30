import { z } from "zod";
export const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
type User = z.infer<typeof UserSchema>;
// user is already validated/typed — re-parsing is redundant (the cross-layer case).
export function service(user: User) {
  return UserSchema.parse(user);
}
