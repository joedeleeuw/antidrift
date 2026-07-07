type EventKind = "recall" | "capture" | "tool";
type MemoryResult = {
  action?: "recall" | "capture";
  value: string;
};

export function publicActionForEventKind(
  eventKind: EventKind,
): MemoryResult["action"] | undefined {
  if (eventKind === "recall" || eventKind === "capture") return eventKind;
  return undefined;
}

function parseMemoryAction(value: unknown): MemoryResult["action"] | undefined {
  if (value === "recall" || value === "capture") return value;
  return undefined;
}

function routeEventKind(eventKind: EventKind): string {
  if (eventKind === "tool") return "run-tool";
  return eventKind === "recall" ? "load-memory" : "save-memory";
}

void publicActionForEventKind;
void parseMemoryAction;
void routeEventKind;
