// Double JSON.parse is not a Zod concern — the rule must confirm Zod and stay silent here.
export function roundtrip(s: string) {
  const a = JSON.parse(s);
  return JSON.parse(a);
}
