// File correctly extends firebase User in one place but also redeclares the base shape.
// Tests that a correct usage in the same file does not suppress the inventory fact elsewhere.

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
