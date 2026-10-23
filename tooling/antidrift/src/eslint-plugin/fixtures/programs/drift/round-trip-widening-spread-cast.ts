type TextPart = { type: "text"; text: string };
type ToolPart = { type: `tool-${string}`; toolCallId: string; input: unknown };
type StepPart = { type: "step-start" };
type Part = TextPart | ToolPart | StepPart;
type ChatMessage = { id: string; parts: Part[] };

// The part is viewed as a record to rewrite one field, and the rewritten copy
// is cast back to the part union the record view dropped.
export const truncateToolInput = (message: ChatMessage): ChatMessage => ({
  ...message,
  parts: message.parts.map((part) => {
    const record = part as Record<string, unknown>;
    const input = record.input as { code?: string } | undefined;
    return typeof input?.code === "string"
      ? ({
          ...record,
          input: { code: input.code.slice(0, 10) },
        } as unknown as ChatMessage["parts"][number])
      : part;
  }),
});
