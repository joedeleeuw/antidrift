import type { UserDto } from "@agent-guardrails/contracts";

export type LoadUserResult =
  { state: "failed"; message: string } | { state: "loaded"; user: UserDto };

export function loadUser(_signal: AbortSignal): Promise<LoadUserResult> {
  // Template placeholder: apps call an API client, not raw fetch in components.
  return Promise.resolve({
    state: "loaded",
    user: {
      id: "user_123",
      email: "user@example.test",
      displayName: "Ada Lovelace",
      status: "active",
    },
  });
}
