import { describe, expect, it, vi } from "vitest";

import { verifySession } from "./verify-session.mjs";

function writer() {
  const chunks = [];
  return {
    chunks,
    write(value) {
      chunks.push(value);
      return true;
    },
  };
}

describe("verifySession", () => {
  it("emits structured stop-hook feedback when verification fails in hook mode", () => {
    const stdout = writer();
    const stderr = writer();
    const spawn = vi.fn(() => ({
      status: 1,
      stdout: "release verification failed\n",
      stderr: "typecheck reported an error\n",
    }));

    const status = verifySession({
      commands: [["pnpm", ["verify:release"]]],
      hook: true,
      spawn,
      stdout,
      stderr,
      exit: (code) => code,
    });

    const payload = JSON.parse(stdout.chunks.join(""));
    expect(status).toBe(0);
    expect(stderr.chunks).toEqual([]);
    expect(payload.decision).toBe("block");
    expect(payload.reason).toContain(
      "Required verification failed: pnpm verify:release",
    );
    expect(payload.reason).toContain("release verification failed");
    expect(payload.reason).toContain("typecheck reported an error");
  });
});
