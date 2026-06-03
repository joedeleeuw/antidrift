import { brand, type Brand, type Unbrand } from "@joedeleeuw/antidrift/brand";

const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));

type UserId = Brand<string, "UserId">;
type RawUserId = Unbrand<UserId>;

declare const raw: unknown;

const made = UserId.make(raw);
const rawLiteral: RawUserId = "user_123";
const rawAgain: RawUserId = made;
const safe = UserId.safe(raw);

// @ts-expect-error Raw strings must cross the brand boundary before becoming UserId.
rawLiteral satisfies UserId;

if (UserId.is(raw)) {
  const checked: UserId = raw;
  checked satisfies UserId;
}

if (safe.ok) {
  const checked: UserId = safe.value;
  checked satisfies UserId;
}

rawAgain satisfies string;
