import { z } from "zod";

const jobSchema = z.object({ id: z.string(), status: z.string() });

declare function enqueue(batch: unknown[]): void;

// The value escapes inside an array literal.
export function schedule(raw: unknown) {
  const job = jobSchema.parse(raw);
  enqueue([job]);
  return jobSchema.parse(job);
}
