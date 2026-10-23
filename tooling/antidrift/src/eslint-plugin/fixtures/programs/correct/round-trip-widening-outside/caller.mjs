// The fixture program holds only .ts and .tsx files, so this caller is out of
// its view: it passes a number.
import { describeOutsideValue } from "./describe.ts";

export const describedOutside = describeOutsideValue(42);
