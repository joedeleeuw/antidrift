export function describe(input: unknown): string {
  return typeof input === "string" ? input : "";
}
