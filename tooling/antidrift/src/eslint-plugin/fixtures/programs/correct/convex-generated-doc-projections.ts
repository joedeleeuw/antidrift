// Legitimate Convex generated owner usage: bare Doc alias, Pick/Omit derivations, and
// Doc-typed field/parameter usage are references or projections, not hand-written forks.
// Expected: 0 errors.
import type { Doc, Id } from "../convex/_generated/dataModel";

export type MachineDoc = Doc<"machines">;

export type MachineCard = Pick<Doc<"machines">, "name" | "endpoints">;

export type MachineDraft = Omit<Doc<"machines">, "_id" | "_creationTime">;

export function endpointCount(machine: Doc<"machines">) {
  return machine.endpoints.length;
}

export function machineKey(id: Id<"machines">) {
  return String(id);
}
