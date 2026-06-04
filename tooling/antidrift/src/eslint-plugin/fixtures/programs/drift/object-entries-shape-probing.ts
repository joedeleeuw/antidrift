declare const raw: Record<string, unknown>;

export const normalized = Object.fromEntries(
  Object.entries(raw).map(([key, value]) => {
    if (value && typeof value === "object") {
      return [
        key,
        ("numberValue" in value ? value.numberValue : undefined) ??
          ("stringValue" in value ? value.stringValue : undefined) ??
          ("boolValue" in value ? value.boolValue : undefined) ??
          null,
      ];
    }
    return [key, value];
  }),
);
