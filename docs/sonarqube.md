# SonarQube Setup

SonarQube is the PR and trend governance layer. Local enforcement remains in ESLint, TypeScript, Vitest, and hooks.

## Local report generation

```bash
pnpm policy:reports
pnpm sonar:prepare
```

`pnpm sonar:prepare` converts ESLint JSON into Sonar generic external issue format at:

```txt
reports/antidrift-sonar.json
```

## Sonar scanner properties

See `sonar-project.properties`.

The template imports external policy findings with:

```properties
sonar.externalIssuesReportPaths=reports/antidrift-sonar.json
```

## Suggested quality gate

See `sonar/quality-gate.ai-strict.yaml`.

The intended posture is:

- no new critical/blocker issues
- all new security hotspots reviewed
- high new-code coverage
- low new-code duplication
- imported AI-policy issues block the gate
- complexity and duplication trend visibility on every PR

## Suggested quality profile

See `sonar/quality-profile.ai.yaml`.

Use a Sonar Way-derived JavaScript and TypeScript profile as the baseline. Do not treat Sonar as the custom antidrift rule host: Sonar owns broad, maintained portfolio analysis and gate metrics; ESLint plus `typescript-eslint` owns local deterministic feedback and antidrift-specific rules. `pnpm sonar:prepare` imports the ESLint findings as generic external issues so they appear beside native Sonar findings.

The profile should keep these families active and visible:

| Family | Sonar owns | Why it belongs in Sonar |
|---|---|---|
| Agentic injection | `tssecurity/jssecurity:S8701`, `S8702`, `S8704`, `S8705`, `S8706`, `S8707` plus classic injection rules such as `S2076`, `S3649`, `S5131`, `S5144`, `S5334`, `S6109` | These are maintained vulnerability/data-flow rules and should not be approximated with custom string matching. |
| Secrets, crypto, HTTP security | `typescript/javascript:S6418`, `S2068`, `S2245`, `S2755`, `S3330`, `S4502`, `S4830`, `S5122`, `S5332`, `S5547`, `S5659` | These are broad security hotspot/vulnerability checks that are outside antidrift's narrow rule scope. |
| Control-flow correctness | `S1143`, `S128`, `S1764`, `S1862`, `S2871`, `S4123`, `S4822`, `S6544` | These catch plausible generated-code bugs that compile and often evade review. |
| Complexity and duplication | `S3776`, `S4144`, `S3516` plus duplication metrics in the gate | Sonar is the right trend/governance layer for cognitive complexity and copy-paste growth. |
| Test integrity | `S1607`, `S2187`, `S2699`, `S2970`, `S5906`, `S5914`, `S5958`, `S5973`, `S6426` | Keeps generated tests from being empty, skipped, focused, assertion-free, or weak. |
| React and accessibility | `S6439`, `S6440`, `S6442`, `S6443`, `S6477`, `S6479`, `S6481`, `S6754`, `S6756`, `S6759`, `S6793`, `S6807`, `S6841`, `S6844`, `S6853` | Complements `react-hooks`, React compiler lint, and local UI rules with PR-visible UI correctness and accessibility findings. |
| TypeScript hygiene | `S4325`, `S4335`, `S4621`, `S4782`, `S6564`, `S6568`, `S6571`, `S6590` | These are maintained type-system hygiene rules; antidrift should only own type rules with repo-specific or agent-specific semantics. |
| External antidrift | Imported `antidrift/*` findings | Sonar reports these, but the rules remain managed in ESLint because external rules are not part of Sonar quality profiles. |

Do not add style/import formatting to the Sonar profile. The baseline ESLint config owns import grouping, type imports, duplicate imports, JSX prop ordering, and local formatting because those need fast autofixable feedback before Sonar runs.

## Current research notes

Sonar's docs say quality profiles define which language rules are active, and Sonar Way is the built-in starting point that can be extended. For AI code, Sonar recommends Sonar Way or derivatives as the profile base. Sonar's quality gates enforce new-code and overall-code metrics; the built-in AI gate adds stricter overall-code security/reliability review on top of the normal new-code gate.

As of 2026-06-08, Sonar's public `next.sonarqube.com` instance exposes a built-in `Sonar agentic AI` JavaScript/TypeScript profile. I checked it against `Sonar way`; it was a subset, not a superset, with no agentic-only JS/TS rules. Keep `Sonar way` as the parent and explicitly watch the agentic injection rules above. Re-review this before publishing a 1.0 profile because Sonar's profile content is product-owned and can change.

Useful references:

- SonarQube quality gates: https://docs.sonarsource.com/sonarqube-server/2026.1/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates
- SonarQube quality profiles for AI code: https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-profiles-for-ai-code
- SonarQube quality gates for AI code: https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-gates-for-ai-code
- Generic external issue import: https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/importing-external-issues/generic-issue-import-format
