import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import review from "../../../test/corpus/homer-review.json" with { type: "json" };
import corpus from "./fixtures/homer-corpus.json" with { type: "json" };
import { createPortableHarness } from "../../../test/support/portable-harness.mjs";

function objectId(type, bytes) {
  return createHash("sha1")
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function blobAtPath(filename) {
  expect(objectId("commit", Buffer.from(corpus.commit))).toBe(corpus.revision);
  let id = corpus.commit.split("\n")[0].slice(5);
  for (const part of filename.split("/")) {
    const bytes = Buffer.from(corpus.trees[id], "base64");
    expect(objectId("tree", bytes)).toBe(id);
    let found;
    for (let offset = 0; offset < bytes.length; ) {
      const space = bytes.indexOf(32, offset);
      const zero = bytes.indexOf(0, space);
      const name = bytes.subarray(space + 1, zero).toString();
      const entryId = bytes.subarray(zero + 1, zero + 21).toString("hex");
      if (name === part) found = entryId;
      offset = zero + 21;
    }
    expect(found, filename).toBeDefined();
    id = found;
  }
  return id;
}

const harness = createPortableHarness(corpus.manifests);
afterAll(() => harness.dispose());
describe.each(corpus.files)("Homer $filename", (entry) => {
  it("pins verbatim source to its Git blob and named revision", () => {
    expect(corpus.revision).toBe("dc7d554d9925f5a4e6adc73844e8cd1b6057c3fc");
    expect(blobAtPath(entry.filename)).toBe(entry.blob);
    expect(createHash("sha256").update(entry.source).digest("hex")).toBe(
      entry.sha256,
    );
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(entry.source)}\0`)
        .update(entry.source)
        .digest("hex"),
    ).toBe(entry.blob);
  });
  it.each(entry.expected)(
    "pins $rule file, line, column and message",
    (expected) => {
      const actual = harness.lint(
        expected.rule,
        entry.source,
        entry.filename,
        expected.options,
      );
      expect(
        actual.map(({ ruleId, line, column, message }) => ({
          ruleId,
          line,
          column,
          message,
        })),
      ).toEqual(
        expected.messages.toSorted(
          (a, b) => a.line - b.line || a.column - b.column,
        ),
      );
    },
  );
});

it("rejects a fabricated wrapper and a file-name substitution", () => {
  const entry = corpus.files[0];
  expect(
    objectId(
      "blob",
      Buffer.from(`const sample = ${JSON.stringify(entry.source)};`),
    ),
  ).not.toBe(blobAtPath(entry.filename));
  expect(blobAtPath(corpus.files[1].filename)).not.toBe(entry.blob);
});

it("pins every reviewed custom sample and preserves signal while removing sampled noise", () => {
  for (const rule of review.rules) {
    for (const sample of rule.samples) {
      const file = corpus.files.find((entry) => entry.filename === sample.file);
      expect(file, sample.file).toBeDefined();
      expect(file.source.split("\n")[sample.line - 1]).toBe(sample.anchor);
      expect(file.sha256).toBe(sample.sha256);
      if (rule.decision === "withdraw") continue;
      const expected = file.expected.find((entry) => entry.rule === rule.rule);
      expect(expected).toBeDefined();
      const fires = expected.messages.some(
        (message) => message.line === sample.line,
      );
      expect(fires, `${rule.rule} ${sample.file}:${sample.line}`).toBe(
        sample.classification === "TP",
      );
    }
  }
});
