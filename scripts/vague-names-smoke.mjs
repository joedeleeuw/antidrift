import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ruleId = "antidrift/no-vague-names";

const source = `export function ForwardingPanel({ title, ...props }: { title: string; hidden: boolean }) {
  return <section {...props}>{title}</section>;
}
export function collectRest({ title, ...props }: { title: string; hidden: boolean }) {
  return [title, props.hidden];
}
export function headerLines(headers: Map<string, string>) {
  const lines: string[] = [];
  for (const [name, value] of headers) lines.push(name + value);
  for (const [fieldKey, value = ""] of headers) lines.push(fieldKey + value);
  headers.forEach((value, headerName) => lines.push(headerName + value));
  return lines;
}
export function storeSetting(key: string, value = "") {
  return key + value;
}
export function repeatText(label: string, value: number) {
  return label.repeat(value);
}
export function scheduleReminder(id: string, value: number) {
  return [id, Date.now() + value];
}
export function boxSize() {
  const [width, value] = [320, 200];
  return width * value;
}
export function pointSum(points: [number, number][]) {
  return points.map(([x, value]) => x + value);
}
export function tripleRows(rows: [string, string, string][]) {
  return rows.map(([first, second, value]) => first + second + value);
}
export function suffixedPair(entries: [string, string][]) {
  return entries.map(([key, fieldValue]) => key + fieldValue);
}
export function keyedParams(key: string, params: string) {
  return key + params;
}
export const value = 1;
export function assertUnreachable(value: never): never {
  throw new Error(String(value));
}
export function cloned<T>(value: T): T {
  return structuredClone(value);
}
export function paid<T extends { amount: number }>(value: T) {
  return value.amount;
}
export function spreadAll<T>(value: Array<T>): T[] {
  return [...value];
}
export function outerOwned<T>(entries: T[]) {
  return entries.map((value: T) => value);
}
`;

const expectedReports = [
  "4:props is an abbreviation of 'properties'",
  "11:value is a vague noun",
  "14:value is a vague noun",
  "17:value is a vague noun",
  "20:value is a vague noun",
  "24:value is a vague noun",
  "28:value is a vague noun",
  "31:value is a vague noun",
  "34:fieldValue is a filler suffix",
  "36:params is a vague noun",
  "39:value is a vague noun",
  "46:value is a vague noun",
  "49:value is a vague noun",
  "53:value is a vague noun",
];

const reportPattern = /^'(\w+)' is (.+?)\. Name the binding/;

function report(line, message) {
  const [, name, reason] = reportPattern.exec(message) ?? [];
  return `${line}:${name} is ${reason}`;
}

export async function runVagueNamesSmoke({
  workDir,
  oxlintBin,
  oxlintConfigFile,
  eslint,
}) {
  const file = join(workDir, "vague-names.tsx");
  writeFileSync(file, source, "utf8");

  let oxlintOut = "";
  try {
    oxlintOut = execFileSync(
      oxlintBin,
      ["-c", oxlintConfigFile, "--format", "json", file],
      { encoding: "utf8" }
    );
  } catch (error) {
    oxlintOut = String(error.stdout ?? "");
  }
  const oxlintReports = (JSON.parse(oxlintOut).diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code === "antidrift(no-vague-names)")
    .map((diagnostic) =>
      report(diagnostic.labels[0].span.line, diagnostic.message)
    );
  assert.deepEqual(
    oxlintReports.toSorted(),
    expectedReports.toSorted(),
    `Expected Oxlint ${ruleId} to exempt forwarded props, keyed values and domainless values, and report only the controls`
  );

  const [eslintResult] = await eslint.lintFiles([file]);
  const eslintReports = eslintResult.messages
    .filter((message) => message.ruleId === ruleId)
    .map(({ line, message }) => report(line, message));
  assert.deepEqual(
    eslintReports.toSorted(),
    expectedReports.toSorted(),
    `Expected ESLint ${ruleId} to exempt forwarded props, keyed values and domainless values, and report only the controls`
  );
}
