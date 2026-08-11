import { queryGeneric as query } from "convex/server";
import { z } from "zod/v4";

const MachineRegistration = z.object({
  machineId: z.string(),
  name: z.string(),
});

declare function convexValidatorFromJsonSchema(document: unknown): unknown;

// The Zod v4 JSON Schema rendering reaches the registration through one
// const binding.
const returnsDocument = z.toJSONSchema(MachineRegistration);

export const listMachines = query({
  returns: returnsDocument,
  handler: () => [],
});

// A handwritten converter wraps the representation on the way in.
export const getMachine = query({
  returns: convexValidatorFromJsonSchema(z.toJSONSchema(MachineRegistration)),
  handler: () => null,
});

// The converter result bound once, then registered.
const converted = convexValidatorFromJsonSchema(
  z.toJSONSchema(MachineRegistration),
);

export const searchMachines = query({
  returns: converted,
  handler: () => [],
});
