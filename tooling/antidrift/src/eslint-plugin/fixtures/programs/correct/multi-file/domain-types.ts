// Canonical types file — extends firebase rather than redeclaring.
import type { User } from "firebase/auth";

export type AppUser = User & {
  tenantId: string;
  role: "admin" | "member" | "viewer";
};

export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: AppUser }
  | { status: "unauthenticated" };
