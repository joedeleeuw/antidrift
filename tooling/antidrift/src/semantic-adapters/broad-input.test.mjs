import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  isAppeasementCastSourceType,
  isAppeasementCastTargetType,
  isNamedTypeReference,
} from "./broad-input.mjs";

function programFor(sourceText) {
  const root = mkdtempSync(join(tmpdir(), "antidrift-broad-input-"));
  const fileName = join(root, "fixture.ts");
  writeFileSync(fileName, sourceText);
  const program = ts.createProgram([fileName], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  });
  return { checker: program.getTypeChecker(), sourceFile: program.getSourceFile(fileName) };
}

function variableType(checker, sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return checker.getTypeAtLocation(declaration.name);
      }
    }
  }
  throw new Error(`Missing variable ${name}`);
}

function aliasType(checker, sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      return checker.getTypeFromTypeNode(statement.type);
    }
  }
  throw new Error(`Missing type alias ${name}`);
}

describe("broad-input appeasement cast helpers", () => {
  it("classifies broad source types and named object contract targets", () => {
    const { checker, sourceFile } = programFor(`
      type UserDto = { id: string; email: string };
      type Empty = {};
      declare const rawAny: any;
      declare const rawUnknown: unknown;
      declare const label: string;
    `);

    expect(isAppeasementCastSourceType(variableType(checker, sourceFile, "rawAny"))).toBe(true);
    expect(isAppeasementCastSourceType(variableType(checker, sourceFile, "rawUnknown"))).toBe(true);
    expect(isAppeasementCastSourceType(variableType(checker, sourceFile, "label"))).toBe(false);
    expect(isAppeasementCastTargetType(aliasType(checker, sourceFile, "UserDto"))).toBe(true);
    expect(isAppeasementCastTargetType(aliasType(checker, sourceFile, "Empty"))).toBe(false);
    expect(isNamedTypeReference({ type: "TSTypeReference" })).toBe(true);
    expect(isNamedTypeReference({ type: "TSStringKeyword" })).toBe(false);
  });
});
