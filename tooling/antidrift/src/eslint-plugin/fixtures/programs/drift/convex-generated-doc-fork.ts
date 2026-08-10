// Hand-written exact structural copy of the Convex generated Doc<"machines"> owner.
// The owner is implicit: convex/_generated/dataModel exports DataModel, whose
// machines.document shape is Doc<"machines">. Expected: 1 error.
import type { Id, MachineEndpoint } from "../convex/_generated/dataModel";

export type LocalMachine = {
  _id: Id<"machines">;
  _creationTime: number;
  name: string;
  endpoints: MachineEndpoint[];
};
