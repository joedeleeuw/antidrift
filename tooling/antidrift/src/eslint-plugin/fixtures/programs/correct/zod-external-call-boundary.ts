import { getAuth, type Auth } from "firebase/auth";
import { z } from "zod";

const AuthSchema = z.custom<Auth>();

export function assignedExternalResult() {
  const auth = getAuth();
  return AuthSchema.parse(auth);
}

export function inlineExternalResult() {
  return AuthSchema.parse(getAuth());
}
