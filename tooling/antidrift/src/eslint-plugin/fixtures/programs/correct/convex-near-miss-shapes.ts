// Same-shaped-but-not-exact types must stay silent: renamed, retyped, added, or dropped
// properties are not exact owner copies. Expected: 0 errors.
import type { Id, MachineEndpoint } from "../convex/_generated/dataModel";

export type MachineSummaryWrongType = {
  id: string;
  name: string;
  address: string;
  online: string;
};

export type MachineSummaryWithLocal = {
  id: string;
  name: string;
  address: string;
  online: boolean;
  fetchedAt: number;
};

export type LocalMachineRenamed = {
  _id: Id<"machines">;
  _creationTime: number;
  label: string;
  endpoints: MachineEndpoint[];
};
