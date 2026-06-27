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
      stdout: "external-corpus fail: Only 1 external corpus repositories are available; 2 required by --require for this slice.\n",
      stderr: "report: reports/external-corpus.json\n",
    }));

    const status = verifySession({
      commands: [["pnpm", ["policy:validate-external-corpus"]]],
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
      "Required verification failed: pnpm policy:validate-external-corpus",
    );
    expect(payload.reason).toContain("external-corpus fail:");
    expect(payload.reason).toContain("report: reports/external-corpus.json");
  });
});
