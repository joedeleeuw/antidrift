function parsePayload(text: string) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw error;
  }
}

void parsePayload;
