import { z } from "zod";

const metricSchema = z.object({ id: z.string(), value: z.number() });

declare function sink(payload: { label: string }): void;
declare const label: string;

// The object literal does not carry the value, so provenance survives.
export function record(raw: unknown) {
  const metric = metricSchema.parse(raw);
  sink({ label });
  return metricSchema.parse(metric);
}
