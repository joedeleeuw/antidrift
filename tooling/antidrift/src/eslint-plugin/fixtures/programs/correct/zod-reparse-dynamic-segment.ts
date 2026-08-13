import { z } from "zod";

const schemas = {
  create: z.object({ id: z.string() }),
  update: z.object({ id: z.string(), name: z.string() }),
};

// The segment is dynamic, so no canonical path exists and the rule stays silent.
export function handle(kind: "create" | "update", raw: unknown) {
  const value = schemas[kind].parse(raw);
  return schemas[kind].parse(value);
}
