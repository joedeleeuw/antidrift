import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseTypeOwnerInventoryArgs,
  typeOwnerInventory,
} from "./type-owner-inventory.mjs";

const require = createRequire(import.meta.url);
const firebasePackageDir = dirname(require.resolve("firebase/package.json"));

const roots = [];

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "antidrift-type-owner-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

function writeFixtureRepo() {
  const root = tempRepo();
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(firebasePackageDir, join(root, "node_modules", "firebase"), "dir");
  writeProgram(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeProgram(
    root,
    "src/user-info.ts",
    `import type { UserInfo } from "firebase/auth";

export type CopiedUserInfo = {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly providerId: string;
  readonly phoneNumber: string | null;
};

export type LoosenedUserInfo = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerId: string;
  phoneNumber: string | null;
};

export interface UnrelatedDraft {
  alpha: string;
  beta: number;
  gamma: boolean;
  delta: string;
}

export type UserInfoReference = UserInfo;
`,
  );
  writeProgram(
    root,
    "src/user-info.test.ts",
    `export type TestCopiedUserInfo = {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly providerId: string;
  readonly phoneNumber: string | null;
};
`,
  );
  return root;
}

function fixturePlans(root) {
  return [
    {
      repo: "fixture",
      label: "app",
      repoCandidates: [root],
      tsconfig: "tsconfig.json",
      targets: ["src/**/*.ts"],
    },
  ];
}

describe("parseTypeOwnerInventoryArgs", () => {
  it("defaults to the upstream report path and slice", () => {
    expect(parseTypeOwnerInventoryArgs([])).toEqual({
      repo: null,
      slice: "type-owner-inventory",
      output: "reports/type-owner-inventory.json",
      targets: null,
    });
  });

  it("parses repo csv and brace target globs without splitting inside braces", () => {
    expect(
      parseTypeOwnerInventoryArgs([
        "--repo",
        "murderbox,agent-guardrails-monorepo-template",
        "--targets",
        "src/**/*.{ts,tsx},apps/**/*.tsx",
        "--slice",
        "upstream-delta",
        "--output",
        "out.json",
      ]),
    ).toEqual({
      repo: ["murderbox", "agent-guardrails-monorepo-template"],
      slice: "upstream-delta",
      output: "out.json",
      targets: ["src/**/*.{ts,tsx}", "apps/**/*.tsx"],
    });
  });
});

describe("typeOwnerInventory", () => {
  it("skips when no repository candidate exists", async () => {
    const result = await typeOwnerInventory({
      plans: [
        {
          repo: "ghost",
          label: "app",
          repoCandidates: ["/definitely/not/a/repo"],
          tsconfig: "tsconfig.json",
          targets: ["src/**/*.ts"],
        },
      ],
      output: null,
      progress: () => {},
      report: () => {},
    });

    expect(result.decision).toBe("skip");
    expect(result.results[0]).toMatchObject({
      repo: "ghost",
      decision: "skip",
    });
  });

  it("classifies exact and loosened copies of an installed package owner", async () => {
    const root = writeFixtureRepo();
    const output = join(root, "reports", "inventory.json");

    const result = await typeOwnerInventory({
      plans: fixturePlans(root),
      output,
      progress: () => {},
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.checkedFiles).toBe(2);
    expect(result.scannedTypeCount).toBe(4);
    expect(result.rows).toHaveLength(3);
    expect(result.relationCounts).toEqual({
      "exact-owner-copy": 2,
      "loosened-owner-copy": 1,
      "partial-owner-copy": 0,
    });

    expect(result.rows).toEqual([
      {
        file: "src/user-info.test.ts",
        line: 1,
        localName: "TestCopiedUserInfo",
        relation: "exact-owner-copy",
        owner: "@firebase/auth#UserInfo",
        authorityState: "proposal",
        propCount: 6,
        test: true,
      },
      {
        file: "src/user-info.ts",
        line: 3,
        localName: "CopiedUserInfo",
        relation: "exact-owner-copy",
        owner: "@firebase/auth#UserInfo",
        authorityState: "proposal",
        propCount: 6,
        test: false,
      },
      {
        file: "src/user-info.ts",
        line: 12,
        localName: "LoosenedUserInfo",
        relation: "loosened-owner-copy",
        owner: "@firebase/auth#UserInfo",
        authorityState: "proposal",
        propCount: 6,
        test: false,
      },
    ]);
    expect(
      result.rows.some((row) => row.localName === "UnrelatedDraft"),
    ).toBe(false);
    expect(
      result.rows.some((row) => row.localName === "UserInfoReference"),
    ).toBe(false);

    expect(result.proposalCount).toBe(1);
    expect(result.proposals).toEqual([
      {
        name: "UserInfo",
        package: "@firebase/auth",
        exportName: "UserInfo",
        reason:
          "exact-owner-copy of @firebase/auth#UserInfo redeclared at src/user-info.test.ts:1 and 1 more",
      },
    ]);

    const written = JSON.parse(readFileSync(output, "utf8"));
    expect(written.decision).toBe("pass");
    expect(written.schemaVersion).toBe(1);
    expect(written.rows).toHaveLength(3);
  }, 30_000);
});
