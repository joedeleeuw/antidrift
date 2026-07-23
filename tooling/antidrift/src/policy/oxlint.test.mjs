import { describe, expect, it, vi } from "vitest";

import { parseOxlintArgs, runOxlint } from "./oxlint.mjs";

describe("oxlint wrapper", () => {
  it("defaults to source directories that exist", () => {
    const parsed = parseOxlintArgs([], {
      cwd: "/repo",
      exists: (path) => path === "/repo/apps" || path === "/repo/packages",
    });

    expect(parsed).toEqual({
      help: false,
      passthrough: [],
      targets: ["apps", "packages"],
    });
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
