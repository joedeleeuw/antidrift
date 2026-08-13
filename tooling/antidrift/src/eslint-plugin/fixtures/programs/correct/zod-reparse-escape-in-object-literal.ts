import { z } from "zod";

const eventSchema = z.object({ id: z.string(), kind: z.string() });

declare function sink(payload: { payload: unknown }): void;

// The value escapes inside an object literal, not as a bare argument.
export function emit(raw: unknown) {
  const event = eventSchema.parse(raw);
  sink({ payload: event });
  return eventSchema.parse(event);
}
