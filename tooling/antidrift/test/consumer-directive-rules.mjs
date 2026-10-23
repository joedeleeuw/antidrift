import { directiveRuleCases } from "./directive-rule-cases.mjs";

export function proveDirectiveRules({ file, lintOxlint, packedFiles }) {
  const overrides = [];
  for (const entry of directiveRuleCases) {
    const filename = `directive-proofs/${entry.name}/${entry.filename ?? "component.tsx"}`;
    file(filename, entry.invalid);
    overrides.push({
      files: [filename],
      rules: { [`antidrift/${entry.name}`]: ["error", entry.options ?? {}] },
    });
    if (!packedFiles.has(`package/dist/oxlint-plugin/rules/${entry.name}.js`)) {
      throw new Error(`Directive rule missing from tarball: ${entry.name}`);
    }
  }
  file(
    "directive.config.json",
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
    })
  );
  const output = lintOxlint("directive-proofs", "directive.config.json");
  const expected = new Set(
    directiveRuleCases.map((entry) => `antidrift(${entry.name})`)
  );
  const counts = new Map();
  for (const diagnostic of output.diagnostics ?? []) {
    if (!expected.has(diagnostic.code)) {
      throw new Error(
        `Unexpected directive rule diagnostic: ${JSON.stringify(diagnostic)}`
      );
    }
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  for (const rule of expected) {
    if (counts.get(rule) !== 1) {
      throw new Error(
        `Packed directive rule ${rule}: expected one finding, got ${counts.get(rule) ?? 0}`
      );
    }
  }
  console.log(
    `     directive rules: ${expected.size} packed rules each report one finding`
  );
}
