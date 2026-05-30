// Correctly composes firebase User into discriminated unions — no shape redeclaration.
import type { User } from "firebase/auth";

export type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated" };

export type UserOrGuest =
  | { kind: "user"; data: User }
  | { kind: "guest"; sessionId: string };
