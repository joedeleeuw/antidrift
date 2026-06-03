import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brand } from "./index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

describe("brand", () => {
  it("creates a validation boundary for branded values", () => {
    const UserId = brand("UserId", (value) => typeof value === "string" && value.startsWith("user_"));

    expect(UserId.make("user_123")).toBe("user_123");
    expect(UserId.is("user_123")).toBe(true);
    expect(UserId.safe("team_123").ok).toBe(false);
    expect(() => UserId.make("team_123")).toThrow(TypeError);
  });

  it("type-checks the real consumer program", () => {
    expect(() => {
      execFileSync(
        "pnpm",
        ["exec", "tsc", "-p", "tooling/antidrift/src/brand/fixtures/tsconfig.json", "--noEmit", "--pretty", "false"],
        { cwd: repoRoot, stdio: "pipe" },
      );
    }).not.toThrow();
  });
});
