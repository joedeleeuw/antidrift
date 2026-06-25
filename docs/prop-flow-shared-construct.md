# Prop-flow (drilling + dead-end)

## Governing constraint: minimal layers

The design is chosen to minimize layers. **Two layers, period:** the TypeScript toolchain, and our
code. Everything else — Rust, oxc, tsgo, Go, oxlint, FFI/napi/wasm, JSON-IPC, a second engine/pass,
a graph library — is layer-bloat and is rejected. It runs as **one Node program**; whole-program, so
it's a CI pass, not an editor rule.

## The two layers

```
  feed: file(s)
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │ TypeScript toolchain    (ONE layer, one dep) │
  │   parse → scope/references → type checker    │  liveness FREE; types = same install
  └───────────────────────┬─────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────┐
  │ our code               (the only other layer)│
  │   prop slots                                 │
  │   · name-match edges        → drilling       │
  │   · type-resolved edges     → dead-end       │
  └───────────────────────┬─────────────────────┘
            ├────────────────►  EXIT 1 · local unused → SUPPRESSED (ecosystem-owned)
            ▼
  ┌─────────────────────────────────────────────┐
  │ recurse   (~15-line fixed point — no graph lib)
  └───────────────────────┬─────────────────────┘
            └────────────────►  EXIT 2 · drilling (depth ≥ N) · dead-end
```

**The trick:** parse, scope/liveness, **and** types all come from the *same* `typescript` install —
types are **not a separate layer**, they're the toolchain we're already on. That's why all-TS beats
Rust/oxc here: Rust gives parse+scope but then needs tsgo (a *second* runtime) for types → more
layers, not fewer. Rust was a *speed* goal; minimal-layers is the priority, and it wins.

## What we borrow vs. own

- **Borrow (the TS toolchain):** parse, scope/`references` (all liveness), the type checker.
- **Own:** edge-building + a ~15-line recurse. That's the entire surface.

The recurse is hand-rolled on purpose — a graph lib (graphology/graphlib) would be another layer for
~15 lines of BFS.

## Report levels (one graph, sorted)

| Prop | Level | Emit? | Needs types? |
|---|---|---|---|
| has a local read | live | no | — |
| no read, no forward edge | **pure-unused** (EXIT 1) | **No** — ecosystem owns it (`no-unused-vars`, `react/no-unused-prop-types`) | no |
| forwarded ≥ N deep | **drilling** (EXIT 2) | warn — tunable `N` | **no** — name-match + scope |
| no read, forwarded, chain dies | **dead-end** (EXIT 2) | error | **yes** — checker resolves the opaque edges |

`pure-unused` is the recursion's base case — computed, suppressed.

## Drilling vs. dead-end (types only where forced)

- **Drilling:** name-match edges + scope. **No type checker.** Already fires on real murderbox
  (`selectedModel` / `selectedChatHarness` → `depth 2`). Single-file prior art: `jjenzz/sweepi`.
- **Dead-end:** needs the type checker to resolve the **opaque tail** — the real run left **~52% of
  forward edges opaque** (children that are cross-package, aliased, re-exported, or read `props.x`
  instead of destructuring). The checker resolves those by referencing the child's **canonical /
  generated type** (never a forked local copy). **Library-boundary children stay `unknown`/opaque
  even with types** — we can't see a library's body, and that's correct.

The type checker is the **one layer that scope forces** (dead-end needs it). It's free — same
toolchain. The only way to go lower is to drop dead-end → drilling-only.

## Constraints

- Whole-program → CI, not a per-file editor rule.
- `opaque → unknown` (assume alive) → **no false positives**; misses are the safe direction.

## Status

- **Net-new.** Prior-art search found only single-file rules (within-component unused; within-file
  depth counting). No whole-program cross-component dead-forwarded-prop rule exists anywhere; Knip
  lists cross-component unused props as a missing feature. The cross-file dead-end is unbuilt.
- **Unimplemented — not unproven.** Design de-risked: local mechanics (the cheap rule fired), drilling
  fired on the real pre-fix murderbox tree, solver shape (codegrade lane2 passes). Promotion-proof
  (cross-repo corpus) is a later gate, after it's built and run.

## Next

Implement the single TS program: prop slots → name-match drilling edges → type-resolved dead-end
edges → ~15-line recurse. Drilling already fires on the pre-fix murderbox tree; add type-resolution
to recover the dead-end opaque tail, then run full scope. No Rust, no second engine, no graph lib.
