import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
const payload = input ? JSON.parse(input) : {};
const text = JSON.stringify(payload);

const blocked = [
  /rm\s+-rf\s+[/.*]/iu,
  /git\s+reset\s+--hard/iu,
  /git\s+clean\s+-fdx/iu,
  /chmod\s+-R\s+777/iu,
  /curl\s+[^|]+\|\s*(?:bash|sh)/iu,
];

for (const pattern of blocked) {
  if (pattern.test(text)) {
    console.error(`Blocked dangerous shell command by policy: ${pattern}`);
    process.exit(2);
  }
}
