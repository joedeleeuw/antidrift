import { Schema } from "effect";

const AuthSnapshot = Schema.Struct({
  userId: Schema.String,
  signedIn: Schema.Boolean,
});
type AuthSnapshotType = Schema.Schema.Type<typeof AuthSnapshot>;

declare function getAuthSnapshot(): AuthSnapshotType;

// Erasure then Effect decode — the Effect twin of the zod parse laundering.
export function readAuthState() {
  const result: unknown = getAuthSnapshot();
  return Schema.decodeUnknownSync(AuthSnapshot)(result);
}
