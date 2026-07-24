import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkRegistries } from "../check-registries.mjs";
import {
  touch,
  workspace,
  writeRegistry,
  writeValidRulesRegistry,
} from "../../../test/support/registry-workspace.mjs";

describe("domain and architecture registries", () => {
  it("accepts valid registry ownership paths", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(
      join(root, "packages/domain/src/user.ts"),
      'export const userStatuses = ["active"] as const;\n',
    );
    writeFileSync(
      join(root, "packages/domain/src/auth.ts"),
      'export const roles = ["admin"] as const;\n',
    );
    touch(root, "packages/gateways/src/aiGateway.ts");
    touch(root, "architecture/approved-dependencies.yaml");
    writeRegistry(
      root,
      "domain",
      `
canonicalEntities:
  User: packages/domain/src/user.ts
statuses:
  UserStatus:
    owner: packages/domain/src/user.ts
    valuesExport: userStatuses
    values: [active]
roles:
  owner: packages/domain/src/auth.ts
  valuesExport: roles
  values: [admin]
`,
    );
    writeRegistry(
      root,
      "gateways",
      `
approvedGateways:
  ai:
    wrapper: packages/gateways/src/aiGateway.ts
    bannedDirectImports: [openai]
`,
    );
    writeRegistry(
      root,
      "dependencies",
      `
runtimeDependencyPolicy:
  requireApproval: true
  approvalFile: architecture/approved-dependencies.yaml
  bannedVersionSpecifiers: [latest]
`,
    );
    writeRegistry(
      root,
      "ownership",
      `
packageTypeOwners:
  firebaseAuthUser:
    package: "@firebase/auth"
    exportName: User
    reason: Firebase Auth User is the accepted auth user contract.
`,
    );
    writeValidRulesRegistry(root);
    expect(checkRegistries({ repoRoot: root, report: () => undefined })).toBe(
      true,
    );
  });
  it("rejects malformed package owner facts", () => {
    const root = workspace();
    const messages = [];
    writeRegistry(
      root,
      "ownership",
      `
packageTypeOwners:
  firebaseAuthUser:
    package: "@firebase/auth"
`,
    );
    writeValidRulesRegistry(root);
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "packageTypeOwners.firebaseAuthUser.exportName must be a non-empty string",
    );
    expect(messages.join("\n")).toContain(
      "packageTypeOwners.firebaseAuthUser.reason must be a non-empty string",
    );
  });
  it("rejects domain registry values that drift from owner exports", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(
      join(root, "packages/domain/src/user.ts"),
      'export const userStatuses = ["active", "disabled"] as const;\n',
    );
    writeRegistry(
      root,
      "domain",
      `
    statuses:
      UserStatus:
        owner: packages/domain/src/user.ts
        valuesExport: userStatuses
        values: [active]
`,
    );
    writeValidRulesRegistry(root);
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "statuses.UserStatus.values must match exported userStatuses",
    );
  });
  it("rejects registry entries that point at missing owner files", () => {
    const root = workspace();
    const messages = [];
    writeRegistry(
      root,
      "domain",
      `
canonicalEntities:
  User: packages/domain/src/user.ts
`,
    );
    writeValidRulesRegistry(root);
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/domain.yaml canonicalEntities.User path does not exist",
    );
  });
  it("rejects absolute and repository-root generated paths", () => {
    const root = workspace();
    const generatedFile = join(root, "generated", "types.ts");
    touch(root, "generated/types.ts");
    writeRegistry(
      root,
      "generated",
      `
generatedSources:
  types:
    generated: ${JSON.stringify(generatedFile)}
  root:
    generated: .
`,
    );
    writeValidRulesRegistry(root);
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/generated.yaml generatedSources.types.generated must be a relative repo path",
    );
    expect(messages.join("\n")).toContain(
      "policy/registries/generated.yaml generatedSources.root.generated must be a relative repo path",
    );
  });
  it("requires every generated source to declare a non-empty path", () => {
    const root = workspace();
    writeRegistry(
      root,
      "generated",
      `
generatedSources:
  missing: {}
  empty:
    generated: ""
`,
    );
    writeValidRulesRegistry(root);
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/generated.yaml generatedSources.missing.generated must be a non-empty string",
    );
    expect(messages.join("\n")).toContain(
      "policy/registries/generated.yaml generatedSources.empty.generated must be a non-empty string",
    );
  });
});
