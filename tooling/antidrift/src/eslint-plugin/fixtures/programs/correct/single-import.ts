// Imports and uses firebase types directly — no redeclaration anywhere.
import type { User } from "firebase/auth";

export function getDisplayName(user: User): string {
  return user.displayName ?? "Anonymous";
}

export function isVerified(user: User): boolean {
  return user.emailVerified;
}
