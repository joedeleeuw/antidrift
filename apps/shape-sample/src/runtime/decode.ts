export type Decoder<T> = (raw: unknown, path: string) => T;

export type YieldOf<G> =
  G extends AsyncGenerator<infer Y, unknown, unknown> ? Y : never;

class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly received: unknown
  ) {
    super(`${path}: expected ${expected}`, {
      cause: { path, expected, received },
    });
    this.name = "DecodeError";
  }
}

export function expectString(raw: unknown, path: string): string {
  if (typeof raw !== "string") {
    throw new DecodeError(path, "string", raw);
  }
  return raw;
}

export function expectNumber(raw: unknown, path: string): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new DecodeError(path, "number", raw);
  }
  return raw;
}

export function expectBoolean(raw: unknown, path: string): boolean {
  if (typeof raw !== "boolean") {
    throw new DecodeError(path, "boolean", raw);
  }
  return raw;
}

export function expectNull(raw: unknown, path: string): null {
  if (raw !== null) {
    throw new DecodeError(path, "null", raw);
  }
  return raw;
}

export function expectDate(raw: unknown, path: string): Date {
  const parsed = raw instanceof Date ? raw : new Date(expectString(raw, path));
  if (Number.isNaN(parsed.getTime())) {
    throw new DecodeError(path, "ISO-8601 date", raw);
  }
  return parsed;
}

export function expectLiteral<const T extends string | number | boolean>(
  raw: unknown,
  path: string,
  value: T
): T {
  if (raw !== value) {
    throw new DecodeError(path, JSON.stringify(value), raw);
  }
  return value;
}

export function expectArray<T>(
  raw: unknown,
  path: string,
  item: Decoder<NoInfer<T>>
): T[] {
  if (!Array.isArray(raw)) {
    throw new DecodeError(path, "array", raw);
  }
  return raw.map((entry: unknown, index) => item(entry, `${path}[${index}]`));
}

function expectRecord(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DecodeError(path, "object", raw);
  }
  return Object.fromEntries(Object.entries(raw));
}

export function firstOf<T>(
  raw: unknown,
  path: string,
  variants: readonly Decoder<NoInfer<T>>[]
): T {
  const failures: string[] = [];
  for (const variant of variants) {
    try {
      return variant(raw, path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new DecodeError(path, `one of: ${failures.join(" | ")}`, raw);
}

export function expectObject<T>(
  raw: unknown,
  path: string,
  build: (record: Record<string, unknown>) => NoInfer<T>
): T {
  return build(expectRecord(raw, path));
}
