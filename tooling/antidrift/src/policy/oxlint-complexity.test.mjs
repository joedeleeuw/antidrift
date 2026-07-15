import { describe, expect, it, vi } from "vitest";

import {
  oxlintComplexityConfig,
  oxlintComplexityIgnorePatterns,
  parseOxlintComplexityArgs,
  runOxlintComplexity,
} from "./oxlint-complexity.mjs";

describe("oxlint complexity wrapper", () => {
  it("defaults to source directories that exist", () => {
    const parsed = parseOxlintComplexityArgs([], {
      cwd: "/repo",
      exists: (path) => path === "/repo/apps" || path === "/repo/packages",
    });

    expect(parsed).toEqual({
      help: false,
      passthrough: [],
      targets: ["apps", "packages"],
    });
  });

  it("passes bundled complexity config and ignores to oxlint", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const status = runOxlintComplexity({
      argv: ["src", "--", "--format", "json"],
      cwd: "/repo",
      spawn,
      exit: (code) => code,
    });

    expect(status).toBe(0);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toContain("--config");
    expect(args).toContain(oxlintComplexityConfig);
    expect(args).toContain("--disable-nested-config");
    for (const pattern of oxlintComplexityIgnorePatterns) {
      expect(args).toContain(pattern);
    }
    expect(args.slice(-3)).toEqual(["--format", "json", "src"]);
    expect(options).toMatchObject({ cwd: "/repo", stdio: "inherit" });
  });
});
