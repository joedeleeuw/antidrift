import { describe, expect, it } from "vitest";

import {
  canonicalStatusLiteralOwner,
  isStatusContextName,
  isStatusLiteralContext,
} from "./type-owner.mjs";

function withParent(node, parent) {
  node.parent = parent;
  return node;
}

describe("type-owner status literal helpers", () => {
  it("matches canonical status literals only in status type contexts", () => {
    const statuses = {
      UserStatus: {
        owner: "packages/domain/src/user.ts",
        values: ["active", "disabled"],
      },
    };
    const statusLiteral = withParent(
      { type: "TSLiteralType", literal: { value: "active" } },
      { type: "TSTypeAliasDeclaration", id: { name: "UserStatus" } },
    );
    const variantLiteral = withParent(
      { type: "TSLiteralType", literal: { value: "active" } },
      {
        type: "TSPropertySignature",
        key: { type: "Identifier", name: "variant" },
      },
    );

    expect(canonicalStatusLiteralOwner(statusLiteral, statuses)).toMatchObject({
      name: "UserStatus",
      owner: "packages/domain/src/user.ts",
      value: "active",
    });
    expect(canonicalStatusLiteralOwner(variantLiteral, statuses)).toBeNull();
    expect(isStatusLiteralContext(statusLiteral, "UserStatus")).toBe(true);
    expect(isStatusContextName("project_status", "ProjectStatus")).toBe(true);
    expect(isStatusContextName("variant", "UserStatus")).toBe(false);
  });
});
