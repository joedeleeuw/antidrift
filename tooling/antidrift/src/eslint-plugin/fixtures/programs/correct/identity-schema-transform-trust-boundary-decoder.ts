import { z } from "zod";

declare function idFromHistoryKey(historyKey: string): string;

export const ConversationIndexSchema = z
  .object({
    id: z.string().optional(),
    historyKey: z.string().min(1),
    title: z.string().optional(),
    messageCount: z.number().optional(),
    selected: z.boolean().optional(),
  })
  .strip()
  .transform((raw) => ({
    id: raw.id || idFromHistoryKey(raw.historyKey),
    historyKey: raw.historyKey,
    title: raw.title?.trim() || "New conversation",
    messageCount: Math.max(0, raw.messageCount ?? 0),
    selected: Boolean(raw.selected),
  }));
