// Zod schema whose inferred type mirrors firebase/auth UserInfo — no import from firebase.
// The agent defined the shape inline in zod instead of importing the canonical type.
// Expected: 1 error on UserInfo (the inferred type alias matches firebase/auth#UserInfo)

import { z } from "zod";

const userInfoSchema = z.object({
  uid: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  photoURL: z.string().nullable(),
  providerId: z.string(),
  phoneNumber: z.string().nullable(),
});

export type UserInfo = z.infer<typeof userInfoSchema>;
