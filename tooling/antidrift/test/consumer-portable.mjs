import { portableCases } from "./portable-cases.mjs";

export function provePortableRules({ file, lintOxlint, packedFiles }) {
  for (const required of [
    "package/NOTICE",
    "package/licenses/Apache-2.0.txt",
    "package/licenses/Rika-Labs-MIT.txt",
  ]) {
    if (!packedFiles.has(required)) {
      throw new Error(`Portable provenance missing from tarball: ${required}`);
    }
  }
  const overrides = [];
  for (const entry of portableCases) {
    const base = `portable-proofs/${entry.name}`;
    const filename = `${base}/${entry.filename ?? "component.tsx"}`;
    file(filename, entry.invalid);
    file(
      `${base}/package.json`,
      JSON.stringify({ name: "portable-proof", private: true }),
    );
    file(
      `${base}/apps/client/package.json`,
      JSON.stringify({
        name: "@proof/client",
        dependencies: { "@homer/shared": "workspace:*" },
      }),
    );
    file(
      `${base}/apps/other/package.json`,
      JSON.stringify({ name: "@proof/other" }),
    );
    overrides.push({
      files: [filename],
      rules: {
        [`antidrift/${entry.name}`]: [
          "error",
          entry.name === "docs-source-policy"
            ? { ...entry.options, policyFile: filename }
            : (entry.options ?? {}),
        ],
      },
    });
    if (
      !packedFiles.has(`package/src/oxlint-plugin/portable/${entry.name}.js`)
    ) {
      throw new Error(`Portable rule missing from tarball: ${entry.name}`);
    }
  }
  file(
    "portable.config.json",
    JSON.stringify({
      categories: {
        correctness: "off",
        nursery: "off",
        pedantic: "off",
        perf: "off",
        restriction: "off",
        style: "off",
        suspicious: "off",
      },
      jsPlugins: [
        { name: "antidrift", specifier: "@joedeleeuw/antidrift/oxlint-plugin" },
      ],
      overrides,
    }),
  );
  const output = lintOxlint("portable-proofs", "portable.config.json");
  const diagnostics = output.diagnostics ?? [];
  const expected = new Set(
    portableCases.map((entry) => `antidrift(${entry.name})`),
  );
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    if (!expected.has(diagnostic.code)) {
      throw new Error(
        `Unexpected portable consumer diagnostic: ${JSON.stringify(diagnostic)}`,
      );
    }
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  for (const rule of expected) {
    if (counts.get(rule) !== 1) {
      throw new Error(
        `Packed portable rule ${rule}: expected one finding, got ${counts.get(rule) ?? 0}`,
      );
    }
  }
  console.log(
    `     portable rules: ${expected.size} packed rules each report one finding; licenses included`,
  );
}
