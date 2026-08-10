import { queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import { JSONSchema, Schema } from "effect";

const MachineRegistration = Schema.Struct({
  machineId: Schema.String,
  name: Schema.String,
});

declare function buildApiDocumentation(jsonSchema: unknown): void;

// Documentation sink: the JSON Schema is rendered for humans, never
// registered as a runtime validator.
export function emitMachineDocumentation() {
  const document = JSONSchema.make(MachineRegistration);
  buildApiDocumentation(document);
}

// The Convex registration keeps its own runtime owner.
export const listMachines = query({
  args: { machineId: v.string() },
  returns: v.array(v.object({ machineId: v.string(), name: v.string() })),
  handler: () => [],
});

// A JSON Schema produced inside the handler body is return-path data, not a
// validator registration.
export const describeMachines = query({
  handler: () => JSONSchema.make(MachineRegistration),
});
