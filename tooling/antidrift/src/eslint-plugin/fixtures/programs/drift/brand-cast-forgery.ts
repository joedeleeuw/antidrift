import type { Brand } from "@joedeleeuw/antidrift/brand";

type UserId = Brand<string, "UserId">;

declare const raw: string;

export const forged = raw as UserId;
export const tunneled = raw as unknown as UserId;
