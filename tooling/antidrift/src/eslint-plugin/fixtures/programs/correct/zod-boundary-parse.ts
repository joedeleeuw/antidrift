import { z } from "zod";
export const UserSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });
// Raw external input — the legitimate first parse at the boundary. Must NOT fire.
export function ingest(raw: unknown) { return UserSchema.parse(raw); }
export function ingestAny(body: any) { return UserSchema.parse(body); }
