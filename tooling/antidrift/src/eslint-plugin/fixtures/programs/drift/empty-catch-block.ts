function parsePayload(text: string) {
  try {
    return JSON.parse(text);
  } catch {
  }
}

void parsePayload;
