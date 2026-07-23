import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import {
  classifyWriteValue,
  createReactStateTracker,
  frameStatePayload,
  lifecycleProof,
} from "./react-state-graph.js";

// Drive the adapter through real ESLint traversal and collect one record per frame.
function analyze(code) {
  const frames = [];
  const linter = new Linter();
  linter.verify(code, {
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      probe: {
        rules: {
          collect: {
            create(context) {
              const tracker = createReactStateTracker({
                context,
                onFrameExit(frame) {
                  frames.push({
                    proof: lifecycleProof(frame),
                    state: frameStatePayload(frame),
                  });
                },
              });
              return tracker.visitors;
            },
          },
        },
      },
    },
    rules: { "probe/collect": "error" },
  });
  return frames;
}

const literal = (value) => ({ type: "Literal", value });

describe("react-state-graph adapter", () => {
  it("classifies setter-write values by behavior, never by name", () => {
    const ctx = { awaitedNames: new Set(["result"]), catchParams: ["err"] };
    expect(classifyWriteValue(literal(true), ctx)).toBe("trueConst");
    expect(classifyWriteValue(literal(false), ctx)).toBe("falseConst");
    expect(classifyWriteValue(literal(null), ctx)).toBe("nullConst");
    expect(
      classifyWriteValue({ type: "Identifier", name: "undefined" }, ctx),
    ).toBe("nullConst");
    expect(classifyWriteValue({ type: "AwaitExpression" }, ctx)).toBe(
      "awaited",
    );
    expect(
      classifyWriteValue({ type: "Identifier", name: "result" }, ctx),
    ).toBe("awaited");
    expect(classifyWriteValue({ type: "Identifier", name: "err" }, ctx)).toBe(
      "caughtError",
    );
    expect(classifyWriteValue({ type: "ArrowFunctionExpression" }, ctx)).toBe(
      "updater",
    );
    // Numeric/string literals are domain values, not lifecycle constants.
    expect(classifyWriteValue(literal(0), ctx)).toBe("other");
    expect(classifyWriteValue(literal(""), ctx)).toBe("other");
  });

  it("proves the hand-rolled resource lifecycle from behavior, not names", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function load(): Promise<string[]>;
      function P() {
        const [rows, setRows] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.proof).toMatchObject({
      boolCell: "setBusy",
      errorCell: "setOops",
      payloadCell: "setRows",
    });
    expect(proven.state.cells.setRows.cell).toBe("rows");
  });

  it("recognizes aliased React useState imports", () => {
    const frames = analyze(`
      import { useState as useReactState } from "react";
      declare function load(): Promise<string[]>;
      function P() {
        const [rows, setRows] = useReactState<string[]>([]);
        const [busy, setBusy] = useReactState(false);
        const [oops, setOops] = useReactState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(true);
  });

  it("ignores imported useState when a local binding shadows it", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function load(): Promise<string[]>;
      function P() {
        function useState<T>(v: T): [T, (v: T) => void] {
          return [v, () => undefined];
        }
        const [rows, setRows] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
    expect(
      frames.every((frame) => Object.keys(frame.state.cells).length === 0),
    ).toBe(true);
  });

  it("ignores imported React objects when a local binding shadows them", () => {
    const frames = analyze(`
      import React from "react";
      declare function load(): Promise<string[]>;
      function P() {
        const React = {
          useState<T>(v: T): [T, (v: T) => void] {
            return [v, () => undefined];
          },
        };
        const [rows, setRows] = React.useState<string[]>([]);
        const [busy, setBusy] = React.useState(false);
        const [oops, setOops] = React.useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
    expect(
      frames.every((frame) => Object.keys(frame.state.cells).length === 0),
    ).toBe(true);
  });

  it("ignores local useState impostors", () => {
    const frames = analyze(`
      function useState<T>(v: T): [T, (v: T) => void] {
        return [v, () => undefined];
      }
      declare function load(): Promise<string[]>;
      function P() {
        const [rows, setRows] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
    expect(
      frames.every((frame) => Object.keys(frame.state.cells).length === 0),
    ).toBe(true);
  });

  it("does not prove stale-while-revalidate (loading + data, no error cell)", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchItems(): Promise<string[]>;
      function P() {
        const [items, setItems] = useState<string[]>([]);
        const [loading, setLoading] = useState(false);
        return async function refresh() {
          setLoading(true);
          try { const n = await fetchItems(); setItems(n); }
          finally { setLoading(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
  });

  it("does not prove pagination (updater + member writes are not a bare awaited payload cell)", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchPage(): Promise<{ items: string[]; next: number }>;
      function P() {
        const [items, setItems] = useState<string[]>([]);
        const [cursor, setCursor] = useState(0);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function more() {
          setBusy(true);
          setOops(null);
          try { const p = await fetchPage(); setItems((prev) => [...prev, ...p.items]); setCursor(p.next); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
  });

  it("reports a request-identity guard on the frame so consumers can downgrade a proven shape", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchUser(s: AbortSignal): Promise<string>;
      function P() {
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          const controller = new AbortController();
          setBusy(true);
          setOops(null);
          try { const u = await fetchUser(controller.signal); if (controller.signal.aborted) return; setUser(u); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(true);
  });

  it("does not treat unrelated abort-shaped members as request guards", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare const request: { aborted: boolean };
      declare const fake: { abort(): void; signal: { aborted: boolean } };
      declare function fetchUser(): Promise<string>;
      function P() {
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try {
            const u = await fetchUser();
            if (request.aborted) return;
            fake.abort();
            if (fake.signal.aborted) return;
            setUser(u);
          }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(false);
  });

  it("does not treat an inert AbortController allocation as a request guard", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchUser(s: AbortSignal): Promise<string>;
      function P() {
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          const controller = new AbortController();
          setBusy(true);
          setOops(null);
          try { const u = await fetchUser(controller.signal); setUser(u); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(false);
  });

  it("does not treat an abort status read after the payload setter as a request guard", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchUser(s: AbortSignal): Promise<string>;
      function P() {
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          const controller = new AbortController();
          setBusy(true);
          setOops(null);
          try { const u = await fetchUser(controller.signal); setUser(u); if (controller.signal.aborted) return; }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(false);
  });

  it("does not treat abort calls as request guards", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function fetchUser(s: AbortSignal): Promise<string>;
      function P() {
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          const controller = new AbortController();
          setBusy(true);
          setOops(null);
          try { const u = await fetchUser(controller.signal); controller.abort(); setUser(u); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(false);
  });

  it("treats synchronous multi-setter UI cleanup as a non-transition frame", () => {
    const frames = analyze(`
      import { useState } from "react";
      function P() {
        const [query, setQuery] = useState("");
        const [page, setPage] = useState(1);
        const [sel, setSel] = useState<string | null>(null);
        return (next: string) => { setQuery(next); setPage(1); setSel(null); };
      }
      void P;
    `);
    expect(frames.some((frame) => frame.proof.proven)).toBe(false);
    const handler = frames.find((frame) => frame.state.setterCount === 3);
    expect(handler.state.transition).toBe(false);
  });

  it("inherits a component-scope request guard so the transition is exempt", () => {
    const frames = analyze(`
      import { useRef, useState } from "react";
      declare function fetchUser(s: AbortSignal): Promise<string>;
      function P() {
        const ref = useRef(new AbortController());
        const [user, setUser] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const u = await fetchUser(ref.current.signal); if (ref.current.signal.aborted) return; setUser(u); }
          catch (e) { setOops(e); }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    const proven = frames.find((frame) => frame.proof.proven);
    expect(proven).toBeTruthy();
    expect(proven.state.requestGuard).toBe(true);
  });

  it("does not let a nested closure independently prove the lifecycle", () => {
    const frames = analyze(`
      import { useState } from "react";
      declare function load(): Promise<string[]>;
      function P() {
        const [rows, setRows] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [oops, setOops] = useState<Error | null>(null);
        return async function go() {
          setBusy(true);
          setOops(null);
          try { const r = await load(); setRows(r); }
          catch (e) {
            setOops(e);
            void (async () => {
              setBusy(true);
              setOops(null);
              try { const r2 = await load(); setRows(r2); }
              catch (e2) { setOops(e2); }
              finally { setBusy(false); }
            })();
          }
          finally { setBusy(false); }
        };
      }
      void P;
    `);
    expect(frames.filter((frame) => frame.proof.proven).length).toBe(1);
  });
});
