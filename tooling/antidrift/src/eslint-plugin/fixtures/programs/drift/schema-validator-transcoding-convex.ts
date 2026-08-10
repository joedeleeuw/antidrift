import { queryGeneric as query } from "convex/server";
import { JSONSchema, Schema } from "effect";

const MachineRegistration = Schema.Struct({
  machineId: Schema.String,
  name: Schema.String,
});

const returnsDocument = JSONSchema.make(MachineRegistration);

// The JSON Schema rendering reaches the registration through one const binding.
export const listMachines = query({
  returns: returnsDocument,
  handler: () => [],
});

// The conversion sits inline in the registration.
export const getMachine = query({
  returns: JSONSchema.make(MachineRegistration),
  handler: () => null,
});
