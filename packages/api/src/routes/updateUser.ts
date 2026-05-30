import { updateUserInputSchema, type UserDto } from "@agent-guardrails/contracts";

import { authorize, requireTenant, requireUser, type RequestContext, validateInput } from "../security";

export type UpdateUserRequest = {
  context: RequestContext;
  body: unknown;
};

export function updateUser(request: UpdateUserRequest): Promise<UserDto> {
  const principal = requireUser(request.context);
  const tenantId = requireTenant(request.context);
  authorize(principal, "project:update");
  const input = validateInput(updateUserInputSchema, request.body);

  return Promise.resolve({
    id: principal.id,
    email: `${tenantId}-${principal.id}@example.test`,
    displayName: input.displayName,
    status: "active",
  });
}
