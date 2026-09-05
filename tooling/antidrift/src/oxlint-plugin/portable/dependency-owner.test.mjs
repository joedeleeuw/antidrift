import { afterAll, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPortableHarness } from "../../../test/support/portable-harness.mjs";

const harness = createPortableHarness();
afterAll(() => harness.dispose());
writeFileSync(
  join(harness.directory, "package.json"),
  JSON.stringify({ name: "consumer", devDependencies: { vitest: "catalog:" } }),
);
mkdirSync(join(harness.directory, "apps/client/scripts"));
writeFileSync(
  join(harness.directory, "apps/client/scripts/package.json"),
  '{"type":"module"}',
);

it("uses the declaring workspace and root development owner through marker manifests", () => {
  expect(
    harness.lint(
      "no-unlisted-external-imports",
      'import { test } from "vitest"; import { model } from "@homer/shared/model-config";',
      "apps/client/scripts/deep/check.ts",
    ),
  ).toEqual([]);
});

it("does not borrow dependencies from siblings or invent undeclared packages", () => {
  expect(
    harness.lint(
      "no-unlisted-external-imports",
      'import React from "react";',
      "apps/other/src/file.ts",
    ),
  ).toHaveLength(1);
  expect(
    harness.lint(
      "no-unlisted-external-imports",
      'import x from "missing";',
      "apps/client/scripts/deep/check.ts",
    ),
  ).toHaveLength(1);
});

it("supports an explicit nearest-package-only development contract", () => {
  expect(
    harness.lint(
      "no-unlisted-external-imports",
      'import { test } from "vitest";',
      "apps/client/scripts/deep/check.ts",
      { ancestorDevDependencies: false },
    ),
  ).toHaveLength(1);
});
