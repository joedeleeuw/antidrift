declare const schema: {
  parse(value: unknown): unknown;
  parseAsync(value: unknown): Promise<unknown>;
  safeParse(value: unknown): {
    error: {
      issues: Array<{ path: string[]; message: string }>;
    };
  };
};

const arrangedBad = { activation: "missing" };

it("flags an arranged parse failure through its issue path", () => {
  const result = schema.safeParse(arrangedBad);

  expect(
    result.error.issues.some((issue) => issue.path.includes("activation")),
  ).toBe(true);
  expect(result.error.issues).toEqual([
    expect.objectContaining({
      path: ["activation"],
      message: "activation is required",
    }),
  ]);
  const issues = result.error.issues;
  expect(issues[0].message).toBe("authored message");
});

it("reports a bare throwing assertion on an arranged parse", () => {
  expect(() => schema.parse(arrangedBad)).toThrow();
  expect(() => schema.parse(arrangedBad)).toThrow("activation is required");
});

it("reports a rejected async parse on arranged input", async () => {
  await expect(schema.parseAsync(arrangedBad)).rejects.toThrow(
    "activation is required",
  );
});
