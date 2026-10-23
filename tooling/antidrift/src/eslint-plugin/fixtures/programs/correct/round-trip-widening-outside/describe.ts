// Its only caller in this program passes a string, but a file of the same
// package that the program does not hold calls it as well, so its callers are
// out of view.
export function describeOutsideValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const describedInside = describeOutsideValue("inside");
