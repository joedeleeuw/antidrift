import selection from "./corpus/native-selection.json" with { type: "json" };

export function proveAdoptionPresets({ file, runJson, lintOxlint, work }) {
  const config = runJson(
    "node",
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { createAdoptionOxlintConfig, adoptionPresets } from "@joedeleeuw/typescript-tooling/oxlint"; assert.throws(() => createAdoptionOxlintConfig({ presets: [] }), /Select at least one/); assert.throws(() => createAdoptionOxlintConfig({ presets: ["nextjs"] }), /Unknown adoption preset/); assert.deepEqual(Object.keys(createAdoptionOxlintConfig({ presets: ["node"] }).rules), Object.keys(adoptionPresets.node)); const config = createAdoptionOxlintConfig({ presets: Object.keys(adoptionPresets) }); assert.equal(Object.keys(config.rules).length, 436); assert(!config.plugins.includes("nextjs")); process.stdout.write(JSON.stringify(config));',
    ],
    work
  );
  const expected = selection.rules.map((row) => row.id).sort();
  if (
    JSON.stringify(Object.keys(config.rules).sort()) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "Packed adoption presets do not contain the complete native inventory."
    );
  }
  for (const [name, setting] of Object.entries(config.rules)) {
    if ((Array.isArray(setting) ? setting[0] : setting) !== "error") {
      throw new Error(`Packed adoption rule is not enabled: ${name}`);
    }
  }
  file("adoption.config.json", JSON.stringify(config));
  file(
    "adoption-proof.tsx",
    [
      'import {} from "empty";',
      'import { expect, it } from "vitest";',
      "/** @param value */",
      "function documented(value) { return value; }",
      'const directory = __dirname + "/assets";',
      "const pi = 3.14159;",
      "Promise.resolve(1).then(value => value);",
      "if (directory) documented(pi);",
      "switch (pi) { case 3: documented(pi); break; default: break; }",
      "class Controller { value = 1; run() { return this.value; } }",
      'const View = () => <img src="x.png" />;',
      'it("matches", () => { expect(pi).toEqual(3); });',
    ].join("\n")
  );
  const result = lintOxlint("adoption-proof.tsx", "adoption.config.json");
  const fired = new Set(
    (result.diagnostics ?? []).map(
      (diagnostic) => diagnostic.code.split("(")[0]
    )
  );
  for (const preset of config.plugins) {
    if (!fired.has(preset)) {
      throw new Error(`Packed native preset did not report: ${preset}`);
    }
  }
  console.log(
    `     native adoption: ${expected.length} error rules; every named preset reports through the packed export`
  );
}
