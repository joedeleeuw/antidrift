// File correctly extends firebase User in one place but also redeclares the base shape.
// Tests that a correct usage in the same file doesn't suppress the drift error elsewhere.
// Expected: 1 error on UserBase (the redeclaration), 0 errors on AppUser (the extension)

import type { User } from "firebase/auth";

export type AppUser = User & { tenantId: string; role: string };

export type UserBase = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};
