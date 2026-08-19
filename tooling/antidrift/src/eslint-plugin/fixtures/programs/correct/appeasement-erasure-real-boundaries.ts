import { z } from "zod";

const authSnapshotSchema = z.object({
  userId: z.string(),
  signedIn: z.boolean(),
});

declare function readRawIpcMessage(): any;

// JSON.parse returns any; narrowing to unknown is the correct move, not erasure.
export function parseJsonBoundary(text: string) {
  const raw: unknown = JSON.parse(text);
  return authSnapshotSchema.parse(raw);
}

// An any-returning source is a real boundary — unknown adds safety here.
export function parseAnySource() {
  const raw: unknown = readRawIpcMessage();
  return authSnapshotSchema.parse(raw);
}

// A reassigned cursor walking an untyped document is a traversal variable,
// not a boundary value; the cast narrows after a guard rather than appeasing.
export function resolvePointer(
  doc: { paths: Record<string, unknown> },
  ref: string,
) {
  let current: unknown = doc;
  for (const segment of ref.split("/")) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
