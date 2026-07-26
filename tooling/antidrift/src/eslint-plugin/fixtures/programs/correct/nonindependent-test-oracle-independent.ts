declare const schema: {
  parse(value: unknown): { activation: string };
};
declare const valid: unknown;
declare const validActivation: string;
declare function renderActivation(value: { activation: string }): string;
declare function captureRuntimeError(): Error;

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
