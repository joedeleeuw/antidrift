import { z } from "zod";

const draftSchema = z.object({ id: z.string(), title: z.string() });

// The value is mutated after parsing, so the second parse is a real check.
export function normalize(raw: unknown, title: string) {
  const draft = draftSchema.parse(raw);
  draft.title = title;
  return draftSchema.parse(draft);
}
