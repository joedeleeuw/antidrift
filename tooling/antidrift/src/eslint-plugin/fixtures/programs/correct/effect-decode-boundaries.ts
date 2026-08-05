import { Schema } from "effect";

const AuthSnapshot = Schema.Struct({
  userId: Schema.String,
  signedIn: Schema.Boolean,
});

// JSON.parse produces any; narrowing to unknown before decoding is correct.
export function decodeJsonBoundary(text: string) {
  const raw: unknown = JSON.parse(text);
  return Schema.decodeUnknownSync(AuthSnapshot)(raw);
}

// Decoding an unknown parameter is the boundary itself.
export function decodePayload(payload: unknown) {
  return Schema.decodeUnknownOption(AuthSnapshot)(payload);
}
