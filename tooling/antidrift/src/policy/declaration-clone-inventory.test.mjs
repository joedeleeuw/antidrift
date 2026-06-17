import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  declarationCloneInventory,
  parseArgs,
} from "./declaration-clone-inventory.mjs";

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "antidrift-declaration-clone-"));
}

function writeProgram(root, relativePath, source) {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

function writeTsconfig(root, relativePath = "tsconfig.json") {
  writeProgram(
    root,
    relativePath,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
}

describe("declarationCloneInventory", () => {
  it("parses brace target globs without splitting inside braces", () => {
    expect(
      parseArgs(["--targets", "src/**/*.{ts,tsx},apps/**/*.tsx"]),
    ).toMatchObject({
      targets: ["src/**/*.{ts,tsx}", "apps/**/*.tsx"],
    });
  });

  it("groups exact object declaration clones by TypeChecker property fingerprints", async () => {
    const root = tempRepo();
    writeTsconfig(root);
    writeProgram(
      root,
      "src/domain.ts",
      `
export interface DomainUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}

export interface TinyUser {
  id: string;
  email: string;
  active: boolean;
}
`,
    );
    writeProgram(
      root,
      "src/api.ts",
      `
export type ApiUser = {
  createdAt: Date;
  active: boolean;
  email: string;
  id: string;
};
`,
    );
    writeProgram(
      root,
      "src/other.ts",
      `
export interface OtherUser {
  id: string;
  email: string;
  active: boolean;
  updatedAt: Date;
}
`,
    );
    writeProgram(
      root,
      "src/loose.ts",
      `
export interface LooseUser {
  readonly id: string;
  email: string;
  active: boolean;
  createdAt?: Date;
}
`,
    );
    writeProgram(
      root,
      "src/alias.ts",
      `
import type { DomainUser } from "./domain";

export type AliasUser = DomainUser;
`,
    );
    writeProgram(
      root,
      "src/extends.ts",
      `
import type { DomainUser } from "./domain";

export interface ExtendedAliasUser extends DomainUser {}
`,
    );
    writeProgram(
      root,
      "src/method.ts",
      `
export interface MethodUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
  serialize(): string;
}
`,
    );

    const result = await declarationCloneInventory({
      plans: [
        {
          repo: "fixture",
          label: "app",
          repoCandidates: [root],
          tsconfig: "tsconfig.json",
          targets: ["src/**/*.ts"],
        },
      ],
      progress: () => {},
      report: () => {},
    });

    expect(result.decision).toBe("pass");
    expect(result.checkedFiles).toBe(7);
    expect(result.declarationCount).toBe(5);
    expect(result.cloneGroupCount).toBe(1);
    expect(result.cloneDeclarationCount).toBe(2);
    expect(result.results[0].cloneGroups).toHaveLength(1);
    expect(result.cloneGroups).toHaveLength(1);

    const [group] = result.cloneGroups;
    expect(group.propCount).toBe(4);
    expect(group.crossFile).toBe(true);
    expect(group.properties).toEqual([
      { name: "active", type: "boolean", optional: false, readonly: false },
      { name: "createdAt", type: "Date", optional: false, readonly: false },
      { name: "email", type: "string", optional: false, readonly: false },
      { name: "id", type: "string", optional: false, readonly: false },
    ]);
    expect(group.declarations).toEqual([
      expect.objectContaining({
        name: "ApiUser",
        kind: "type",
        path: "src/api.ts",
        propCount: 4,
      }),
      expect.objectContaining({
        name: "DomainUser",
        kind: "interface",
        path: "src/domain.ts",
        propCount: 4,
      }),
    ]);
    expect(
      group.declarations.some((declaration) => declaration.name === "TinyUser"),
    ).toBe(false);
    expect(
      group.declarations.some(
        (declaration) => declaration.name === "OtherUser",
      ),
    ).toBe(false);
    expect(
      group.declarations.some(
        (declaration) => declaration.name === "LooseUser",
      ),
    ).toBe(false);
    expect(
      group.declarations.some(
        (declaration) => declaration.name === "AliasUser",
      ),
    ).toBe(false);
    expect(
      group.declarations.some(
        (declaration) => declaration.name === "ExtendedAliasUser",
      ),
    ).toBe(false);
    expect(
      group.declarations.some(
        (declaration) => declaration.name === "MethodUser",
      ),
    ).toBe(false);
    expect(group.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("groups declaration clones across selected tsconfig plans", async () => {
    const root = tempRepo();
    writeTsconfig(root, "packages/domain/tsconfig.json");
    writeTsconfig(root, "packages/api/tsconfig.json");
    writeProgram(
      root,
      "packages/domain/src/user.ts",
      `
export interface DomainUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );
    writeProgram(
      root,
      "packages/api/src/user.ts",
      `
export type ApiUser = {
  createdAt: Date;
  active: boolean;
  email: string;
  id: string;
};
`,
    );

    const result = await declarationCloneInventory({
      plans: [
        {
          repo: "fixture",
          label: "domain",
          repoCandidates: [root],
          tsconfig: "packages/domain/tsconfig.json",
          targets: ["packages/domain/src/**/*.ts"],
        },
        {
          repo: "fixture",
          label: "api",
          repoCandidates: [root],
          tsconfig: "packages/api/tsconfig.json",
          targets: ["packages/api/src/**/*.ts"],
        },
      ],
      progress: () => {},
      report: () => {},
    });

    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "domain", cloneGroupCount: 0 }),
        expect.objectContaining({ label: "api", cloneGroupCount: 0 }),
      ]),
    );
    expect(result.cloneGroupCount).toBe(1);
    expect(result.cloneDeclarationCount).toBe(2);
    expect(result.cloneGroups[0].declarations).toEqual([
      expect.objectContaining({ label: "api", name: "ApiUser" }),
      expect.objectContaining({ label: "domain", name: "DomainUser" }),
    ]);
  });

  it("classifies generated and source declarations in clone groups", async () => {
    const root = tempRepo();
    writeTsconfig(root);
    writeProgram(
      root,
      "src/domain.ts",
      `
export interface DomainUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );
    writeProgram(
      root,
      "src/generated/api.ts",
      `
export interface ApiUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );

    const result = await declarationCloneInventory({
      plans: [
        {
          repo: "fixture",
          label: "app",
          repoCandidates: [root],
          tsconfig: "tsconfig.json",
          targets: ["src/**/*.ts"],
        },
      ],
      progress: () => {},
      report: () => {},
    });

    expect(result.cloneGroupSourceKindCounts).toEqual({
      generatedOnly: 0,
      mixedGenerated: 1,
      sourceOnly: 0,
    });
    expect(result.cloneGroups[0]).toMatchObject({
      sourceKinds: ["generated", "source"],
      generatedOnly: false,
      mixedGenerated: true,
      generatedDeclarationCount: 1,
    });
    expect(result.cloneGroups[0].declarations).toEqual([
      expect.objectContaining({ name: "DomainUser", sourceKind: "source" }),
      expect.objectContaining({
        name: "ApiUser",
        sourceKind: "generated",
      }),
    ]);
  });

  it("keeps non-default corpus plans opt-in", async () => {
    const defaultRoot = tempRepo();
    const fleetRoot = tempRepo();
    writeTsconfig(defaultRoot);
    writeTsconfig(fleetRoot);
    writeProgram(
      defaultRoot,
      "src/domain.ts",
      `
export interface DefaultUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );
    writeProgram(
      fleetRoot,
      "src/domain.ts",
      `
export interface FleetDomainUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );
    writeProgram(
      fleetRoot,
      "src/api.ts",
      `
export interface FleetApiUser {
  id: string;
  email: string;
  active: boolean;
  createdAt: Date;
}
`,
    );

    const plans = [
      {
        repo: "default",
        label: "app",
        repoCandidates: [defaultRoot],
        tsconfig: "tsconfig.json",
        targets: ["src/**/*.ts"],
      },
      {
        repo: "fleet",
        label: "app",
        defaultEnabled: false,
        repoCandidates: [fleetRoot],
        tsconfig: "tsconfig.json",
        targets: ["src/**/*.ts"],
      },
    ];

    const defaultResult = await declarationCloneInventory({
      plans,
      progress: () => {},
      report: () => {},
    });
    const fleetResult = await declarationCloneInventory({
      repo: ["fleet"],
      plans,
      progress: () => {},
      report: () => {},
    });

    expect(defaultResult.results).toHaveLength(1);
    expect(defaultResult.results[0]).toMatchObject({ repo: "default" });
    expect(defaultResult.cloneGroupCount).toBe(0);
    expect(fleetResult.results).toHaveLength(1);
    expect(fleetResult.results[0]).toMatchObject({ repo: "fleet" });
    expect(fleetResult.cloneGroupCount).toBe(1);
  });
});
