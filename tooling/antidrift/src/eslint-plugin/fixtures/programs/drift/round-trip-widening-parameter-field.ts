type TextUIPart = { type: "text"; text: string };
type ReasoningUIPart = { type: "reasoning"; text: string };
type ToolUIPart = { type: `tool-${string}`; toolCallId: string };
type StepStartUIPart = { type: "step-start" };
type ChatResponseResult = {
  status: "completed" | "error" | "aborted";
  message: {
    parts: Array<TextUIPart | ReasoningUIPart | ToolUIPart | StepStartUIPart>;
  };
};

// A local structural copy declares `text?: unknown`; the only caller passes a
// result whose text parts carry `text: string`, which the typeof re-derives.
interface TurnResultLike {
  status: "completed" | "error" | "aborted";
  message: { parts: ReadonlyArray<{ type: string; text?: unknown }> };
}

function classifyTurnOutcome(result: TurnResultLike) {
  let steps = 0;
  let assistantChars = 0;
  for (const part of result.message.parts) {
    if (part.type === "step-start") {
      steps += 1;
    } else if (part.type === "text" && typeof part.text === "string") {
      assistantChars += part.text.length;
    }
  }
  return { steps, assistantChars };
}

export class TurnObserver {
  onChatResponse(result: ChatResponseResult) {
    return classifyTurnOutcome(result);
  }
}
