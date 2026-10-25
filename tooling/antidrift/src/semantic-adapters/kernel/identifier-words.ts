export function splitIdentifierWords(identifier: string): string[] {
  if (identifier.length === 0) {
    return [];
  }
  const normalized = identifier
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (normalized.length === 0) {
    return [];
  }
  return normalized
    .split(/\s+/)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
}
