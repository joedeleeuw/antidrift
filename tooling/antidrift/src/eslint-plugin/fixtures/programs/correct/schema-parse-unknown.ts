import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
});

declare const raw: unknown;

export const user = UserSchema.parse(raw);
