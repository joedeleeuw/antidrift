import { afterAll, describe, expect, it } from "vitest";
import { createPortableHarness } from "../../../test/support/portable-harness.mjs";

const harness = createPortableHarness();
afterAll(() => harness.dispose());

const sanitizer = [{ module: "./security", export: "sanitize" }];

describe("imported sanitizer ownership", () => {
  it.each(["no-unsafe-inner-html", "no-unsanitized-href"])(
    "%s rejects a local identity function and a shadowed import",
    (rule) => {
      const sink =
        rule === "no-unsafe-inner-html"
          ? "<div dangerouslySetInnerHTML={{__html: sanitize(input)}} />"
          : "<a href={sanitize(input)} />";
      for (const source of [
        `const sanitize = value => value; ${sink};`,
        `import { sanitize } from "./security"; function render(sanitize) { return ${sink}; }`,
      ]) {
        expect(
          harness
            .lint(rule, source, undefined, { sanitizers: sanitizer })
            .map((message) => message.ruleId),
        ).toEqual([`antidrift/${rule}`]);
      }
    },
  );
  it("accepts an aliased imported sanitizer and its immutable local alias", () => {
    expect(
      harness.lint(
        "no-unsafe-inner-html",
        'import { sanitize as clean } from "./security"; const sanitize = clean; const html = sanitize(input); <div dangerouslySetInnerHTML={{__html: html}} />;',
        undefined,
        { sanitizers: sanitizer },
      ),
    ).toEqual([]);
    expect(
      harness.lint(
        "no-unsanitized-href",
        'import { sanitize as clean } from "./security"; <a href={clean(input)} />;',
        undefined,
        { sanitizers: sanitizer },
      ),
    ).toEqual([]);
  });
  it("accepts registered imported provenance but rejects comment-only claims", () => {
    expect(
      harness.lint(
        "no-unsafe-inner-html",
        'import { html } from "./static-document"; <div dangerouslySetInnerHTML={{__html: html}} />;',
        undefined,
        { trustedSources: [{ module: "./static-document", export: "html" }] },
      ),
    ).toEqual([]);
    expect(
      harness.lint(
        "no-unsafe-inner-html",
        "// safe-html: reviewed\nnode.innerHTML = external;",
        undefined,
        undefined,
      ),
    ).toHaveLength(1);
  });
});

describe("portable display owners", () => {
  it("names the configured loader and recognizes configured icons", () => {
    const found = harness.lint("no-adhoc-loader", "<BusyGlyph />;", undefined, {
      loaderIcons: ["BusyGlyph"],
      owner: "LoadingIndicator from @ui/loading",
    });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("LoadingIndicator from @ui/loading");
    expect(
      harness.lint("no-adhoc-loader", "<LoadingIndicator />;", undefined, {
        loaderIcons: ["BusyGlyph"],
      }),
    ).toEqual([]);
  });
  it("isolates configured names through the configured text component", () => {
    const options = {
      nameProps: ["customerLabel"],
      isolatingComponents: ["IsolatedText"],
      owner: "IsolatedText from @ui/text",
    };
    expect(
      harness.lint(
        "require-dir-on-rendered-name",
        "<Text>{customer.customerLabel}</Text>;",
        undefined,
        options,
      )[0].message,
    ).toContain("IsolatedText from @ui/text");
    expect(
      harness.lint(
        "require-dir-on-rendered-name",
        "<IsolatedText>{customer.customerLabel}</IsolatedText>;",
        undefined,
        options,
      ),
    ).toEqual([]);
    expect(
      harness.lint(
        "require-dir-on-rendered-name",
        "<bdi>{customer.displayName}</bdi>;",
        undefined,
        undefined,
      ),
    ).toEqual([]);
  });
  it("names the selected number formatter", () => {
    expect(
      harness.lint(
        "no-unformatted-number",
        "<Text>{item.count}</Text>;",
        undefined,
        {
          formatter: "formatCount from @ui/numbers",
        },
      )[0].message,
    ).toContain("formatCount from @ui/numbers");
    expect(
      harness.lint(
        "no-unformatted-number",
        "<Text>{formatCount(item.count)}</Text>;",
        undefined,
        { formatter: "formatCount from @ui/numbers" },
      ),
    ).toEqual([]);
  });
  it("recognizes an application icon without upstream branding", () => {
    expect(
      harness.lint(
        "icon-button-requires-tooltip",
        "<Button><BrandGlyph /></Button>;",
        undefined,
        { iconComponents: ["BrandGlyph"] },
      ),
    ).toHaveLength(1);
    expect(
      harness.lint(
        "icon-button-requires-tooltip",
        '<Button tooltip="Home"><BrandGlyph /></Button>;',
        undefined,
        { iconComponents: ["BrandGlyph"] },
      ),
    ).toEqual([]);
  });
});

describe("fetch identity", () => {
  it.each([
    "const fetchImpl = fetch; fetchImpl(url);",
    "function load(fetchImpl: typeof fetch) { return fetchImpl(url); }",
    "function load(fetchImpl = fetch) { return fetchImpl(url); }",
    "const fetchImpl = globalThis.fetch; const request = fetchImpl; request(url);",
  ])("follows %s", (source) => {
    expect(
      harness.lint("require-fetch-timeout", source, undefined, undefined),
    ).toHaveLength(1);
  });
  it("does not mistake a local fetch function for the platform API", () => {
    expect(
      harness.lint(
        "require-fetch-timeout",
        "function fetch(value) { return value; } fetch(url);",
        undefined,
        undefined,
      ),
    ).toEqual([]);
    expect(
      harness.lint(
        "require-fetch-timeout",
        "function load(fetchImpl: typeof fetch) { return fetchImpl(url, {signal: AbortSignal.timeout(1000)}); }",
        undefined,
        undefined,
      ),
    ).toEqual([]);
  });
});

it("checks documentation policy only at its single configured registry file", () => {
  const options = {
    dependencies: ["react"],
    sources: {},
    policyFile: "docs-sources.mjs",
  };
  expect(
    harness.lint(
      "docs-source-policy",
      "export const registry = {};",
      "docs-sources.mjs",
      options,
    ),
  ).toHaveLength(1);
  expect(
    harness.lint(
      "docs-source-policy",
      "export const value = 1;",
      "src/a.ts",
      options,
    ),
  ).toEqual([]);
  expect(
    harness.lint(
      "docs-source-policy",
      "export const value = 1;",
      "src/b.ts",
      options,
    ),
  ).toEqual([]);
  expect(
    harness.lint(
      "docs-source-policy",
      "export const value = 1;",
      undefined,
      undefined,
    ),
  ).toEqual([]);
});

it("requires actual document headers and accepts the prescribed Response construction", () => {
  expect(
    harness.lint(
      "require-secure-document-response",
      'new Response(bytes, {headers: {"Content-Disposition": "attachment; filename=a.txt"}});',
      undefined,
      undefined,
    ),
  ).toHaveLength(1);
  expect(
    harness.lint(
      "require-secure-document-response",
      'new Response(bytes, {headers: {"Content-Disposition": "attachment; filename=a.txt", "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff"}});',
      undefined,
      undefined,
    ),
  ).toEqual([]);
});

it("follows class bindings without mistaking quoted source for class values", () => {
  expect(
    harness.lint(
      "no-physical-properties",
      'const reserve = compact ? "pr-12" : "pr-2"; <View className={reserve} />;',
      undefined,
      undefined,
    ),
  ).toHaveLength(2);
  expect(
    harness.lint(
      "no-physical-properties",
      "const fixture = '<View className=\"ml-2\" />;';",
      undefined,
      undefined,
    ),
  ).toEqual([]);
  expect(
    harness.lint(
      "no-centered-scroll-column",
      "const fixture = '<div className=\"mx-auto max-w-lg overflow-y-auto\" />;';",
      undefined,
      undefined,
    ),
  ).toEqual([]);
});

it("does not diagnose a helper call from its spelling alone", () => {
  expect(
    harness.lint(
      "no-trivial-property-helpers",
      'import { getString } from "parser"; getString(value);',
      undefined,
      undefined,
    ),
  ).toEqual([]);
});
