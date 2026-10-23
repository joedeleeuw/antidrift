declare function fromJsonSchema(schema: {
  readonly type: "object";
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: readonly string[];
}): unknown;

// The accumulator is declared as an open record although every value written
// into it is a JSON-schema object, and the cast below restores exactly that.
export function contextToolSchema(labels: readonly string[], keyed: boolean) {
  const properties: Record<string, unknown> = {
    label: { type: "string", enum: labels, description: "Block label" },
    content: { type: "string", description: "The main content" },
  };
  if (keyed) {
    properties.metadata = { type: "object", description: "Entry metadata" };
  }
  return fromJsonSchema({
    type: "object",
    properties: properties as Record<string, Record<string, unknown>>,
    required: ["label", "content"],
  });
}
