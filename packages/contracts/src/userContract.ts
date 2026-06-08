import { userStatuses } from "@agent-guardrails/domain";
import { z } from "zod";

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string().min(1),
  status: z.enum(userStatuses),
});

export type UserDto = z.infer<typeof userDtoSchema>;

export const updateUserInputSchema = z.object({
  displayName: z.string().min(1).max(120),
});

export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
