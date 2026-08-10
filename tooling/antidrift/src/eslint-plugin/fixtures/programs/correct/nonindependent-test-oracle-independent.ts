declare const schema: {
  parse(value: unknown): { activation: string; error?: string };
};
declare const valid: unknown;
declare const validActivation: string;
declare function renderActivation(value: { activation: string }): string;
declare function captureRuntimeError(): Error;
declare function postTurn(
  url: string,
  body: unknown,
): Promise<{ json(): Promise<unknown> }>;
declare const serverUrl: string;
declare const arrangedBody: { activation: string };

it("keeps a parsed-value assertion on the success path", () => {
  expect(schema.parse(valid).activation).toEqual(validActivation);
});

it("asserts downstream behavior from a parsed value", () => {
  const parsed = schema.parse(valid);

  expect(renderActivation(parsed)).toBe("activation enabled");
});

it("asserts an error from a non-arranged runtime root", () => {
  const runtimeError = captureRuntimeError();

  expect(runtimeError.message).toBe("runtime unavailable");
});

it("asserts a server error contract from a dynamic response parse", async () => {
  const rejected = await postTurn(serverUrl, arrangedBody);

  expect(schema.parse(await rejected.json()).error).toBe("invalid_request");
});
