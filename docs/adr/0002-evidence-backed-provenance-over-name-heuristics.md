# Evidence-Backed Provenance Over Naming and Syntax Heuristics

Antidrift requires every active rule to prove a semantic invariant—using TypeChecker symbol/shape identity, interprocedural boundary dataflow, or deterministic local provenance—and retires rules that guess intent from identifier naming conventions or syntax bans (`make*` import prefixes, blanket `typeof`/`Reflect.get` bans, or regex-only SQL string checks). Every active rule in `policy/registries/rules.yaml` ships enabled by default at `"error"` (`defaultOff: false`).

## Consequences

- Rules that cannot distinguish legitimate code from Drift without false positives on real production corpora (`Real-Corpus Gate`) are either deepened onto a Semantic Primitive until they reach zero false positives or retired outright; no rule stays parked in `defaultOff: true` limbo.
- Cross-library rules declare a single semantic invariant per concern and recognize all supported library families of that class (Zod, Effect Schema, Valibot, and TypeBox for schema decoding; Convex, TanStack Query, tRPC/oRPC, and SWR for query hooks and cache keys) inside one owner Module.
