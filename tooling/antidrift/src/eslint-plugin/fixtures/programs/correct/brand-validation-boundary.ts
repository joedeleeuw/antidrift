import { brand, type Brand } from "@joedeleeuw/antidrift/brand";

const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));

type UserId = Brand<string, "UserId">;

declare const raw: unknown;

export const userId = UserId.make(raw);

if (UserId.is(raw)) {
  const narrowed: UserId = raw;
  narrowed satisfies UserId;
}

const safe = UserId.safe(raw);

if (safe.ok) {
  const parsed: UserId = safe.value;
  parsed satisfies UserId;
}
