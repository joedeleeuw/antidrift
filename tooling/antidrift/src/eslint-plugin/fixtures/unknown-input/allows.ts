import { z } from "zod";

const message = z.object({ title: z.string() });

export function describe(input: unknown): string {
  return message.parse(input).title;
}
