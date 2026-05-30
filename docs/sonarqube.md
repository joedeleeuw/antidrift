# SonarQube Setup

SonarQube is the PR and trend governance layer. Local enforcement remains in Oxlint, ESLint, TypeScript, Vitest, and hooks.

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
