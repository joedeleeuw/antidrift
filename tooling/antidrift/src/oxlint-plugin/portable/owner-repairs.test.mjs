import { afterAll, describe, expect, it } from "vitest";
import { createPortableHarness } from "../../../test/support/portable-harness.mjs";

const harness = createPortableHarness();
afterAll(() => harness.dispose());
function messages(rule, source, options, filename) {
  return harness.lint(rule, source, filename, options);
}
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
          messages(rule, source, { sanitizers: sanitizer }).map(
            (message) => message.ruleId,
          ),
        ).toEqual([`antidrift/${rule}`]);
      }
    },
  );
  it("accepts an aliased imported sanitizer and its immutable local alias", () => {
    expect(
      messages(
        "no-unsafe-inner-html",
        'import { sanitize as clean } from "./security"; const sanitize = clean; const html = sanitize(input); <div dangerouslySetInnerHTML={{__html: html}} />;',
        { sanitizers: sanitizer },
      ),
    ).toEqual([]);
    expect(
      messages(
        "no-unsanitized-href",
        'import { sanitize as clean } from "./security"; <a href={clean(input)} />;',
        { sanitizers: sanitizer },
      ),
    ).toEqual([]);
  });
  it("accepts registered imported provenance but rejects comment-only claims", () => {
    expect(
      messages(
        "no-unsafe-inner-html",
        'import { html } from "./static-document"; <div dangerouslySetInnerHTML={{__html: html}} />;',
        { trustedSources: [{ module: "./static-document", export: "html" }] },
      ),
    ).toEqual([]);
    expect(
      messages(
        "no-unsafe-inner-html",
        "// safe-html: reviewed\nnode.innerHTML = external;",
      ),
    ).toHaveLength(1);
  });
});

describe("portable display owners", () => {
  it("names the configured loader and recognizes configured icons", () => {
    const found = messages("no-adhoc-loader", "<BusyGlyph />;", {
      loaderIcons: ["BusyGlyph"],
      owner: "LoadingIndicator from @ui/loading",
    });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("LoadingIndicator from @ui/loading");
    expect(
      messages("no-adhoc-loader", "<LoadingIndicator />;", {
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
      messages(
        "require-dir-on-rendered-name",
        "<Text>{customer.customerLabel}</Text>;",
        options,
      )[0].message,
    ).toContain("IsolatedText from @ui/text");
    expect(
      messages(
        "require-dir-on-rendered-name",
        "<IsolatedText>{customer.customerLabel}</IsolatedText>;",
        options,
      ),
    ).toEqual([]);
    expect(
      messages(
        "require-dir-on-rendered-name",
        "<bdi>{customer.displayName}</bdi>;",
      ),
    ).toEqual([]);
  });
  it("names the selected number formatter", () => {
    expect(
      messages("no-unformatted-number", "<Text>{item.count}</Text>;", {
        formatter: "formatCount from @ui/numbers",
      })[0].message,
    ).toContain("formatCount from @ui/numbers");
    expect(
      messages(
        "no-unformatted-number",
        "<Text>{formatCount(item.count)}</Text>;",
        { formatter: "formatCount from @ui/numbers" },
      ),
    ).toEqual([]);
  });
  it("recognizes an application icon without upstream branding", () => {
    expect(
      messages(
        "icon-button-requires-tooltip",
        "<Button><BrandGlyph /></Button>;",
        { iconComponents: ["BrandGlyph"] },
      ),
    ).toHaveLength(1);
    expect(
      messages(
        "icon-button-requires-tooltip",
        '<Button tooltip="Home"><BrandGlyph /></Button>;',
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
    expect(messages("require-fetch-timeout", source)).toHaveLength(1);
  });
  it("does not mistake a local fetch function for the platform API", () => {
    expect(
      messages(
        "require-fetch-timeout",
        "function fetch(value) { return value; } fetch(url);",
      ),
    ).toEqual([]);
    expect(
      messages(
        "require-fetch-timeout",
        "function load(fetchImpl: typeof fetch) { return fetchImpl(url, {signal: AbortSignal.timeout(1000)}); }",
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
    messages(
      "docs-source-policy",
      "export const registry = {};",
      options,
      "docs-sources.mjs",
    ),
  ).toHaveLength(1);
  expect(
    messages(
      "docs-source-policy",
      "export const value = 1;",
      options,
      "src/a.ts",
    ),
  ).toEqual([]);
  expect(
    messages(
      "docs-source-policy",
      "export const value = 1;",
      options,
      "src/b.ts",
    ),
  ).toEqual([]);
  expect(messages("docs-source-policy", "export const value = 1;")).toEqual([]);
});

it("requires actual document headers and accepts the prescribed Response construction", () => {
  expect(
    messages(
      "require-secure-document-response",
      'new Response(bytes, {headers: {"Content-Disposition": "attachment; filename=a.txt"}});',
    ),
  ).toHaveLength(1);
  expect(
    messages(
      "require-secure-document-response",
      'new Response(bytes, {headers: {"Content-Disposition": "attachment; filename=a.txt", "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff"}});',
    ),
  ).toEqual([]);
});

it("follows class bindings without mistaking quoted source for class values", () => {
  expect(
    messages(
      "no-physical-properties",
      'const reserve = compact ? "pr-12" : "pr-2"; <View className={reserve} />;',
    ),
  ).toHaveLength(2);
  expect(
    messages(
      "no-physical-properties",
      "const fixture = '<View className=\"ml-2\" />;';",
    ),
  ).toEqual([]);
  expect(
    messages(
      "no-centered-scroll-column",
      "const fixture = '<div className=\"mx-auto max-w-lg overflow-y-auto\" />;';",
    ),
  ).toEqual([]);
});

it("does not diagnose a helper call from its spelling alone", () => {
  expect(
    messages(
      "no-trivial-property-helpers",
      'import { getString } from "parser"; getString(value);',
    ),
  ).toEqual([]);
});
