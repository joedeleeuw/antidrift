import { z } from "zod";

const authSnapshotSchema = z.object({
  userId: z.string(),
  signedIn: z.boolean(),
});
type AuthSnapshot = z.infer<typeof authSnapshotSchema>;

function getAuthSnapshot(): AuthSnapshot {
  return { userId: "u1", signedIn: true };
}

export function readAuthState() {
  const result: unknown = getAuthSnapshot();
  return authSnapshotSchema.parse(result);
}

export function readAuthStateViaCast() {
  const result = getAuthSnapshot() as unknown;
  return result as AuthSnapshot;
}

// The safe variant launders exactly the same way.
export function readAuthStateSafely() {
  const result: unknown = getAuthSnapshot();
  return authSnapshotSchema.safeParse(result);
}

export function widenForExhaustiveHandling() {
  const value: unknown = { id: "x" };
  return typeof value === "object" && value !== null;
}

const DEFAULT_STATE = {} as unknown;

export function initialStateFor<State>(): State {
  return DEFAULT_STATE as State;
}
