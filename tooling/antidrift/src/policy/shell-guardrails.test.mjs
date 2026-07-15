import { describe, expect, it } from "vitest";

import {
  defaultAstGrepConfig,
  parseShellGuardrailsArgs,
  shellGuardrails,
} from "./shell-guardrails.mjs";

describe("shellGuardrails", () => {
  it("uses an OS-installed ast-grep binary from PATH by default", () => {
    const calls = [];
    const status = shellGuardrails({
      argv: ["--cwd", "/repo"],
      exists: () => {
        throw new Error("bare commands should be resolved by spawn");
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      stderr: { write() {} },
      env: {},
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ast-grep");
    expect(calls[0].args).toEqual([
      "scan",
      "--config",
      defaultAstGrepConfig(),
      ".",
    ]);
    expect(calls[0].options.cwd).toBe("/repo");
  });

  it("runs packaged ast-grep shell rules against the current project by default", () => {
    const calls = [];
    const status = shellGuardrails({
      argv: ["--ast-grep-bin", "/bin/ast-grep", "--cwd", "/repo"],
      exists: () => true,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      stderr: { write() {} },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/bin/ast-grep");
    expect(calls[0].args).toEqual([
      "scan",
      "--config",
      defaultAstGrepConfig(),
      ".",
    ]);
    expect(calls[0].options.cwd).toBe("/repo");
  });

  it("passes explicit scan args through to ast-grep", () => {
    const calls = [];
    shellGuardrails({
      argv: ["--ast-grep-bin", "/bin/ast-grep", "--", "--globs", "*.sh"],
      exists: () => true,
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: 0 };
      },
      stderr: { write() {} },
    });

    expect(calls[0].args).toEqual([
      "scan",
      "--config",
      defaultAstGrepConfig(),
      "--globs",
      "*.sh",
    ]);
  });

  it("validates packaged rule tests in test mode", () => {
    const calls = [];
    shellGuardrails({
      argv: ["test", "--ast-grep-bin", "/bin/ast-grep"],
      exists: () => true,
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: 0 };
      },
      stderr: { write() {} },
    });

    expect(calls[0].args).toEqual([
      "test",
      "--config",
      defaultAstGrepConfig(),
      "--skip-snapshot-tests",
    ]);
  });

  it("parses config and cwd without leaking them to ast-grep passthrough args", () => {
    expect(
      parseShellGuardrailsArgs([
        "--config",
        "custom.yml",
        "--cwd",
        "/repo",
        "--",
        "scripts",
      ]),
    ).toMatchObject({
      config: "custom.yml",
      cwd: "/repo",
      passthrough: ["scripts"],
    });
  });

  it("honors AST_GREP_BIN without requiring the npm cli package", () => {
    expect(
      parseShellGuardrailsArgs([], { AST_GREP_BIN: "/opt/bin/sg" }),
    ).toMatchObject({
      astGrepBinary: "/opt/bin/sg",
    });
  });

  it("fails loudly when an explicit binary path is missing", () => {
    let message = "";
    const status = shellGuardrails({
      argv: ["--ast-grep-bin", "/missing/ast-grep"],
      exists: () => false,
      spawn: () => {
        throw new Error("spawn should not run for a missing explicit path");
      },
      stderr: {
        write: (text) => {
          message +=
            typeof text === "string" ? text : Buffer.from(text).toString();
        },
      },
    });

    expect(status).toBe(1);
    expect(message).toContain("/missing/ast-grep");
  });
});
