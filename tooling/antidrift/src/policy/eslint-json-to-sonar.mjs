import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function severity(eslintSeverity) {
  return eslintSeverity === 2 ? "MAJOR" : "MINOR";
}

export async function eslintJsonToSonar(inputPath = "reports/eslint-antidrift.json", outputPath = "reports/antidrift-sonar.json") {
  let report = [];
  try {
    report = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    report = [];
  }

  const issues = [];
  for (const fileReport of report) {
    for (const message of fileReport.messages ?? []) {
      issues.push({
        engineId: "eslint-antidrift",
        ruleId: message.ruleId ?? "eslint/unknown",
        severity: severity(message.severity),
        type: "CODE_SMELL",
        primaryLocation: {
          message: message.message,
          filePath: fileReport.filePath,
          textRange: {
            startLine: message.line ?? 1,
            startColumn: message.column ?? 1,
            endLine: message.endLine ?? message.line ?? 1,
            endColumn: message.endColumn ?? message.column ?? 1,
          },
        },
      });
    }
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ issues }, null, 2) + "\n", "utf8");
  console.log(`Wrote ${issues.length} Sonar generic external issues to ${outputPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , inputPath, outputPath] = process.argv;
  await eslintJsonToSonar(inputPath, outputPath);
}
