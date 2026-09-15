export function receive(input: Record<string, unknown>): number {
  return Object.keys(input).length;
}
