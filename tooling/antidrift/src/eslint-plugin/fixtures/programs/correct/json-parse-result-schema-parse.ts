import { z } from "zod";

const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().email(),
});

declare const payload: string;

export const user = userDtoSchema.parse(JSON.parse(payload));
