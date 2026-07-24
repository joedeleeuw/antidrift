import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseOxlintArgs, runOxlint } from "./oxlint.mjs";

describe("oxlint wrapper", () => {
  it("defaults to the repository root", () => {
    const repository = mkdtempSync(join(tmpdir(), "antidrift-oxlint-"));

    try {
      mkdirSync(join(repository, "apps"));
      mkdirSync(join(repository, "packages"));
      expect(parseOxlintArgs([], { cwd: repository }).targets).toEqual(["."]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("uses explicit targets instead of the repository root", () => {
    expect(parseOxlintArgs(["src", "tests"], { cwd: "/repo" }).targets).toEqual(
      ["src", "tests"],
    );
  });

  it("passes options and targets to oxlint", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const status = runOxlint({
      argv: ["src", "--", "--format", "json"],
      cwd: "/repo",
      spawn,
      exit: (code) => code,
    });

    expect(status).toBe(0);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toContain("--disable-nested-config");
    expect(args.slice(-3)).toEqual(["--format", "json", "src"]);
    expect(options).toMatchObject({ cwd: "/repo", stdio: "inherit" });
  });
});
