// Zod schema wraps the imported firebase type via z.custom — does not restate its shape.
import type { User } from "firebase/auth";
import { z } from "zod";

export const sessionSchema = z.object({
  user: z.custom<User>(),
  expiresAt: z.number(),
  refreshToken: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;
