# Claude Rule Review Protocol

Claude review is advisory. It is useful for challenging a rule's signal choice, false-positive surface, and production readiness, but it is not the source of truth. Repo evidence, real-corpus gates, and local validation commands decide status.

## Command Shape

Use Claude Opus 4.8 in read-only mode and write every run to files:

```bash
ts=$(date +%Y%m%d-%H%M%S)
out="reports/claude-rule-review-${ts}.md"
err="reports/claude-rule-review-${ts}.stderr"
dbg="reports/claude-rule-review-${ts}.debug.log"

timeout 300 claude -p \
  --model claude-opus-4-8 \
  --effort high \
  --permission-mode dontAsk \
  --tools Read,Grep,Glob \
  --debug-file "$dbg" \
  "$(cat reports/claude-rule-review-prompt.txt)" \
  > "$out" 2> "$err"
```

The debug log must show `Read`, `Grep`, or `Glob` tool use. A response that only reasons from the prompt is not acceptable promotion evidence.

## Review Prompt Template

Use this prompt shape for one rule or one tightly related rule family. For a new investigation, create the `docs/rule-investigations/<candidate>.md` reference doc first and include it in the prompt.

```txt
You are an advisory reviewer only, not the source of truth. Read the repository code before answering. Do not edit files.

Project goal:
- antidrift is an ESLint plus typescript-eslint custom-rule package.
- Prefer TypeChecker, registry, scope/binding, and deterministic source signals.
- Use AST shape only when the syntax itself is the violation.
- Do not suggest Oxlint, Semgrep, CodeQL, or another lint engine for this package.
- Real source programs are the validation surface. Fixtures and reduced programs are regression aids only.
- Stable promotion requires multiple independent repository replications that were not created to satisfy the rule, zero known false positives, zero known false negatives, and no unresolved production concerns.

Read at least:
- policy/registries/rules.yaml
- docs/rule-status-registry.md
- docs/rule-investigations/<candidate>.md
- docs/real-corpus-validation.md
- docs/roadmap.md
- docs/policy-coverage.md
- tooling/antidrift/src/eslint-plugin/index.js
- tooling/antidrift/src/eslint-config/index.mjs
- tooling/antidrift/src/policy/chaski-corpus.mjs
- tooling/antidrift/src/policy/external-corpus.mjs

Rule or candidate under review:
- <rule-id>

Answer with:
1. Current implementation status, based on the code you read.
2. Whether an existing ecosystem rule covers this behavior.
3. The strongest available signal for this rule: TypeChecker, registry, scope/binding, deterministic AST, import graph, or heuristic.
4. Concrete false-positive and false-negative risks.
5. Whether the rule should be marked ecosystem-covered, retired, narrowed, left under-proven, locally ready, or considered for stable promotion.
6. The exact real-corpus evidence still needed.
7. Any productionization concerns such as performance, parserServices no-op behavior, path resolution, or duplicate reports.

Cite local file paths and line numbers where possible.
```

## Promotion Interpretation

Claude may recommend promotion, but a rule is not stable until `policy/registries/rules.yaml` can truthfully record:

- at least two independent repositories with real drift and clean controls,
- no known false positives after inventory,
- no known false negatives in the inspected corpus,
- no unresolved production concerns,
- passing local gates: `pnpm policy:verify-session`,
- advisory Claude review grounded in the current code.

If Claude finds a concern, record it in `policy/registries/rules.yaml` and keep `stable: false`.
