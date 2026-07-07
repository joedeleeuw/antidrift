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

## Non-TypeScript Tooling

This package does not bundle a Trunk-style multi-language lint runner. Keep antidrift's shipped path focused on TypeScript source semantics: ESLint plus `typescript-eslint` for local findings, Vitest and `tsc` for local correctness, and Sonar for portfolio analysis and gate metrics.

When a consuming monorepo has Go, Python, Proto, Bazel, shell, Docker, Kubernetes, or secret-scanning needs, use that repo's native tooling or an orchestrator such as Trunk at the consumer layer. Do not port those checks into custom antidrift ESLint rules. Generated outputs from those ecosystems should be excluded from Sonar and lint scans; the template already excludes protobuf output (`*.pb.ts`, `*.pb.js`, `*.pb.go`, `*.pb.gw.go`) and generated directories.

## Antidrift AI Code Governance Preset

See `sonar/antidrift-ai-code-governance.yaml`.

This is the Antidrift-branded Sonar recommendation for broad AI-assisted code quality and reward-hacking symptoms. It is one declarative preset with two implementation sections:

- `rules`: native Sonar rule keys grouped by Antidrift intent. These decide what Sonar reports.
- `gate`: Sonar metrics and thresholds. These decide what blocks merge.

Native Sonar rule keys remain authoritative. Antidrift curates the posture and imports custom `antidrift/*` ESLint findings through `sonar.externalIssuesReportPaths`; it does not rebrand Sonar-owned rules as custom Antidrift rules.

The intended gate posture is:

- no new untriaged issues
- all new security hotspots reviewed
- high new-code coverage
- low new-code duplication
- imported AI-policy issues block the gate
- severe new reliability, security, and maintainability findings block generated changes

The preset keeps these Sonar-owned rule families visible:

Use a Sonar Way-derived JavaScript and TypeScript profile as the baseline. Do not treat Sonar as the custom antidrift rule host: Sonar owns broad, maintained portfolio analysis and gate metrics; ESLint plus `typescript-eslint` owns local deterministic feedback and antidrift-specific rules. The optional `antidrift oxlint` gate owns the local `complexity` / `max-depth` / `max-params` budget when a project wires it. Those source metrics are not equivalent to Sonar cognitive complexity. `pnpm sonar:prepare` imports the ESLint findings as generic external issues so they appear beside native Sonar findings.

| Family                         | Sonar owns                                                                                                                                                           | Why it belongs in Sonar                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentic injection              | `tssecurity/jssecurity:S8701`, `S8702`, `S8704`, `S8705`, `S8706`, `S8707` plus classic injection rules such as `S2076`, `S3649`, `S5131`, `S5144`, `S5334`, `S6109` | These are maintained vulnerability/data-flow rules and should not be approximated with custom string matching.                                                                                     |
| Secrets, crypto, HTTP security | `typescript/javascript:S6418`, `S2068`, `S2245`, `S2755`, `S3330`, `S4502`, `S4830`, `S5122`, `S5332`, `S5547`, `S5659`                                              | These are broad security hotspot/vulnerability checks that are outside antidrift's narrow rule scope.                                                                                              |
| Control-flow correctness       | `S1143`, `S128`, `S1764`, `S1862`, `S2871`, `S4123`, `S4822`, `S6544`                                                                                                | These catch plausible generated-code bugs that compile and often evade review.                                                                                                                     |
| Complexity and duplication     | `S3776`, `S2004`, `S107`, `S1479`, `S4624`, `S4144`, `S3516` plus duplication metrics in the gate                                                                    | Sonar owns cognitive complexity, interface sprawl, copy-paste growth, and trend/gate posture. The optional `antidrift oxlint` gate catches cyclomatic complexity, depth, and parameter count earlier when wired. |
| Test integrity                 | `S1607`, `S2187`, `S2699`, `S2970`, `S5906`, `S5914`, `S5958`, `S5973`, `S6426`                                                                                      | Keeps generated tests from being empty, skipped, focused, assertion-free, or weak.                                                                                                                 |
| Accessibility                  | `S1082`, `S1090`, `S4084`, `S6793`, `S6807`, `S6821`, `S6822`, `S6841`, `S6844`, `S6853`                                                                             | UI agents routinely omit accessibility unless a maintained scanner makes it visible; this repo does not currently ship `jsx-a11y`.                                                                 |
| TypeScript hygiene             | `S4325`, `S4335`, `S4621`, `S4782`, `S6564`, `S6568`, `S6571`, `S6590`                                                                                               | These are maintained type-system hygiene rules; antidrift should only own type rules with repo-specific or agent-specific semantics.                                                               |
| External antidrift             | Imported `antidrift/*` findings                                                                                                                                      | Sonar reports these, but the rules remain managed in ESLint because external rules are not part of Sonar quality profiles.                                                                         |

Small additive gap matrix:

| Surface                      | Local owner                                | Sonar posture                                                                                                                           | Current gap                                                            |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| React correctness            | `react`, `react-hooks`                     | Do not add native Sonar React rules while local ESLint owns the equivalent check.                                                       | None recorded; `S6441` overlaps `react/no-unstable-nested-components`. |
| Local complexity budget      | Optional `antidrift oxlint` gate | Keep native Sonar cognitive complexity and duplication metrics active; they are not duplicates of local cyclomatic/depth/params checks. | Exact Sonar S3776 behavior is server-side only.                        |
| Accessibility                | None; `jsx-a11y` is not shipped.           | Keep native Sonar accessibility keys through `accessibility-without-jsx-a11y`.                                                          | Maintained UI accessibility scanning.                                  |
| Antidrift-specific contracts | `antidrift/*` imported as external issues. | Report imported findings, but do not rebrand native Sonar rules.                                                                        | Repo-specific and agent-specific semantics.                            |

Do not add style/import formatting to the Sonar profile. The baseline ESLint config owns import grouping, type imports, duplicate imports, JSX prop ordering, and local formatting because those need fast autofixable feedback before Sonar runs.

## Current research notes

Sonar's docs say quality profiles define which language rules are active, and Sonar Way is the built-in starting point that can be extended. For AI code, Sonar recommends Sonar Way or derivatives as the profile base. Sonar's quality gates enforce new-code and overall-code metrics; the built-in AI gate adds stricter overall-code security/reliability review on top of the normal new-code gate.

As of 2026-07-06, Sonar's public `next.sonarqube.com` instance exposes built-in `Sonar agentic AI` JavaScript/TypeScript profiles. Their active `brain-overload` rule set matched `Sonar way` for JavaScript and TypeScript: `S3776`, `S4624`, `S2004`, `S107`, and `S1479`. Keep `Sonar way` as the profile base and review profile diffs before switching, because Sonar owns that content.

Useful references:

- SonarQube quality gates: https://docs.sonarsource.com/sonarqube-server/2026.1/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates
- SonarQube quality profiles for AI code: https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-profiles-for-ai-code
- SonarQube quality gates for AI code: https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-gates-for-ai-code
- Generic external issue import: https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/importing-external-issues/generic-issue-import-format
