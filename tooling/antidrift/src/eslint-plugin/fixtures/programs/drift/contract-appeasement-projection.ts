type EventKind = "recall" | "capture" | "tool";
type MemoryResult = {
  action?: "recall" | "capture";
  value: string;
};

function actionForEventKind(
  eventKind: EventKind,
): MemoryResult["action"] | undefined {
  if (eventKind === "recall" || eventKind === "capture") return eventKind;
  return undefined;
}

function actionLiteralForEventKind(
  eventKind: EventKind,
): MemoryResult["action"] | undefined {
  switch (eventKind) {
    case "recall":
      return "recall";
    case "capture":
      return "capture";
    default:
      return undefined;
  }
}

const actionTernaryForEventKind = (
  eventKind: EventKind,
): MemoryResult["action"] | undefined =>
  eventKind === "recall" ? eventKind : undefined;

void actionForEventKind;
void actionLiteralForEventKind;
void actionTernaryForEventKind;
