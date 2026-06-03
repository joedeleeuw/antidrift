function parsePayload(text: string) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(error);
  }
}

void parsePayload;
