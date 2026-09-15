import { z } from "zod";
declare const text: string;
const settingsSchema = z.object({ enabled: z.boolean() });
const recordSchema = z.record(z.string());
let store: Record<string, string> = {};
store = recordSchema.parse(JSON.parse(text));
const raw: unknown = JSON.parse(text);
const settings = settingsSchema.parse(raw);
function decode() {
  const JSON = { parse: (value: string) => ({ enabled: value === "yes" }) };
  const local: { enabled: boolean } = JSON.parse(text);
  return local;
}
export { store, settings, decode };
