import { z } from "zod";

type ActiveUserEnvelope = {
  user: {
    active: boolean;
  };
};

declare const candidate: unknown;

function isActiveUserEnvelope(value: unknown): value is ActiveUserEnvelope {
  return typeof value === "object"
    && value !== null
    && "user" in value
    && typeof value.user === "object"
    && value.user !== null
    && "active" in value.user
    && typeof value.user.active === "boolean";
}

const ActiveUserEnvelopeSchema = z.object({
  user: z.object({
    active: z.boolean(),
  }),
});

export const viaPredicate = isActiveUserEnvelope(candidate) ? candidate : null;
export const viaSchema = ActiveUserEnvelopeSchema.parse(candidate);
