// Consumes the domain types — imports from the canonical types file, no redeclaration.
import type { AppUser, AuthState } from "./domain-types";

export function getUserId(state: AuthState): string | null {
  if (state.status !== "authenticated") return null;
  return state.user.uid;
}

export function canManage(user: AppUser): boolean {
  return user.role === "admin";
}
