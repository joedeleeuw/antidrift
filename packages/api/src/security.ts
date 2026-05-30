import type { Principal } from "@agent-guardrails/domain";
import { canManageProject } from "@agent-guardrails/domain";
import { z } from "zod";

export type RequestContext = {
  requestId: string;
  tenantId: string;
  principal: Principal;
};

export function requireUser(context: RequestContext): Principal {
  return context.principal;
}

export function requireTenant(context: RequestContext): string {
  return context.tenantId;
}

export function authorize(principal: Principal, action: "project:update"): void {
  if (action === "project:update" && !canManageProject(principal)) {
    throw new Error("Forbidden", { cause: { principalId: principal.id, action } });
  }
}

export function validateInput<TOutput>(schema: z.ZodSchema<TOutput>, input: unknown): TOutput {
  return schema.parse(input);
}
