export type AiGatewayRequest = {
  prompt: string;
  requestId: string;
  timeoutMs: number;
};

export type AiGatewayResponse = {
  text: string;
};

export function completeText(request: AiGatewayRequest): Promise<AiGatewayResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    // Template placeholder: call the approved SDK/client here.
    return Promise.resolve({ text: `request:${request.requestId}:${request.prompt}` });
  } finally {
    clearTimeout(timeout);
  }
}
