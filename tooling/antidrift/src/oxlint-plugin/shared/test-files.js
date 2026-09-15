const testFilenamePattern =
  /(?:(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.][cm]?[jt]sx?$)/u;

export function contextFilename(context) {
  if (typeof context.getFilename === "function") return context.getFilename();
  return context.filename ?? "";
}

export function isTestFilename(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") {
    return true;
  }
  return testFilenamePattern.test(filename);
}

export function staticPropertyName(member) {
  if (member?.type !== "MemberExpression") return "";
  const property = member.property;
  if (!member.computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return "";
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "AwaitExpression" ||
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TypeCastExpression"
  ) {
    current = current.expression ?? current.argument;
  }
  return current;
}
