import { z } from "zod";

const configSchema = z.object({ id: z.string(), enabled: z.boolean() });

const holder: { value: unknown } = { value: null };

// Storing the value in a holder hands it to code that can mutate it back.
export function install(raw: unknown) {
  const config = configSchema.parse(raw);
  holder.value = config;
  return configSchema.parse(config);
}
