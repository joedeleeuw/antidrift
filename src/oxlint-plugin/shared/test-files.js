import { isTestFile } from "./scope.js";

export function contextFilename(context) {
  if (typeof context.getFilename === "function") return context.getFilename();
  return context.filename ?? "";
}

export function isTestFilename(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") {
    return true;
  }
  return isTestFile(filename);
}
