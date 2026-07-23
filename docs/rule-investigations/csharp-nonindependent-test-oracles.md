# C# Non-Independent Test Oracle Investigation

Status: `no rule`. Keep the existing TypeScript concept and the C# guidance, but do not add an
Antidrift C# rule, policy script, Semgrep rule, or ast-grep rule from the current evidence.

## Decision

The Sledge example is a C# instance of the existing
`antidrift/no-nonindependent-test-oracle` invariant. The test constructs records and then checks
facts supplied by that same construction. It does not exercise validation, serialization, a
reducer, a boundary, or another project-owned behavior.

No maintained C# analyzer found in this investigation detects that value-provenance relationship.
The Antidrift package is an ESLint and TypeScript semantic tool with one narrow shell ast-grep
exception. Its source ledger assigns other languages to native consumer tooling. Adding a Roslyn
package or a general multi-language runner would be a new product surface, not a port of the
existing rule.

A precise C# implementation would need Roslyn operation and symbol analysis. One removed test in
one uncommitted worktree is not enough evidence to create and distribute that analyzer. Sledge
should retain the test-quality guidance, keep xUnit analyzers and Sonar's assertion-presence rule as
adjacent baseline coverage, and treat non-independent constructor and membership assertions as a
review concern until independent C# evidence satisfies the promotion gate below.

## Confirmed Example

The removed test was:

```csharp
[Fact]
public void ProposalModelPreservesDevelopmentAndImpactEvidence()
{
    var development = new DevelopmentSnapshot(
        "joedeleeuw/mrp",
        "refs/heads/development",
        "12cf3dece91d02047654d0598f67cacae4856eee");
    var touched = new ImpactFact(
        ImpactKind.Touched,
        "src/routes/releases.tsx",
        "Changes the release route",
        [new EvidenceRef("github.diff", "src/routes/releases.tsx")]);
    var reached = new ImpactFact(
        ImpactKind.Reached,
        "release workflow",
        "The route is consumed by the release workflow",
        [new EvidenceRef("dependency.analysis", "release-route-consumers")]);
    var unknown = new ImpactFact(
        ImpactKind.Unknown,
        "pre-merge correctness",
        "The unmerged proposal has no post-merge record",
        [new EvidenceRef("analysis.boundary", "pre-merge")]);
    var proposal = new ProposalState(
        "mrp-44",
        44,
        "Add release route",
        "https://github.com/joedeleeuw/mrp/pull/44",
        development.Commit,
        "9dbc15570cfe0df5335831b8fa7b85dd458316fd",
        [touched, reached, unknown],
        null);

    Assert.Equal("refs/heads/development", development.RefName);
    Assert.Equal([ImpactKind.Touched, ImpactKind.Reached, ImpactKind.Unknown], proposal.Impact.Select(fact => fact.Kind));
    Assert.All(proposal.Impact, fact => Assert.NotEmpty(fact.Evidence));
}
```

Observed facts:

- `development.RefName` is asserted equal to the literal passed to the
  `DevelopmentSnapshot` constructor.
- The expected enum sequence is the sequence passed through the three arranged `ImpactFact`
  records and then placed into `ProposalState`.
- Every evidence collection was constructed with one element before `Assert.NotEmpty` checked it.
- No project behavior occurs between arrangement and assertion.

This is not evidence that record construction, enum assertions, `Assert.All`, or
`Assert.NotEmpty` are generally low value. The failure is that each oracle depends only on the
test's own arrangement.

## Provenance

Provenance is confirmed from the local Codex session rather than Git history.

- Repository: `/Users/sushi/code/sledge`
- Worktree branch: `foundation/proposal-state-reset`
- Intended file: `engine/tests/Sledge.Engine.Tests/EngineProperties.cs`
- Session: `019f7025-41a9-7833-95bf-63780271f383`
- The exact hunk was removed at `2026-07-17T18:20:56.754Z` before it was committed.
- The user correction in the same session was: `no useless contract tests`, followed by
  `membership tsts` and the request for ESLint-like enforcement.

The current Sledge worktree contains the behavior-bearing validation tests but not this removed
constructor echo test. Sledge was read only during this investigation.

## Mapping To Existing TypeScript Concepts

| C# candidate                          | Existing Antidrift concept                                                                                             | Mapping decision                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constructor or record echo            | `antidrift/no-nonindependent-test-oracle` `inputEcho` branch                                                           | Faithful invariant. The asserted value comes directly from the arrangement that created the asserted object. C# needs semantic constructor/property provenance rather than TypeScript syntax.                                                                    |
| Enum or membership echo               | `antidrift/no-nonindependent-test-oracle` bare-membership and arranged-input branches                                  | Faithful only when the expected member or set is supplied by the same arrangement. Reject a general membership ban. Membership in a reducer output, parsed payload, persisted state, or generated artifact can be real behavior.                                 |
| Reflection or signature contract test | No exact active TypeScript owner; nearest candidate is `test/no-source-shape-guard` in `docs/test-quality-taxonomy.md` | Reject as a generic port. Reflection can be a valid public API, plugin discovery, serialization, ABI, or framework compatibility test. Only a project-owned public contract could make a narrower rule deterministic.                                            |
| Source-text shape test                | `test/no-source-shape-guard` in `docs/test-quality-taxonomy.md`                                                        | Faithful concept. A test that reads production source and checks `.Contains(...)` or a regex is a strong local smell, but production-source provenance and artifact exclusions still belong in the consuming C# repository. Antidrift has no owned C# rule host. |

The first two candidates are one underlying invariant: the oracle must be independent of the data
the test itself arranged. They are not separate rule families.

## Smell Cards

### Constructor Or Record Echo

- Evidence: the first assertion checks the exact `RefName` constructor argument; the other
  assertions inspect collections assembled directly from local record constructors.
- Pattern: an assertion projects from a locally constructed value and compares against the same
  argument, literal, collection element, or collection size used to construct it, with no
  behavior-bearing operation in between.
- Why it matters: the test passes when validation, serialization, reducer logic, and application
  behavior are all broken, as long as the language still assigns constructor arguments to record
  properties.
- Proof needed: Roslyn semantic operations and intramethod value provenance. Syntax alone cannot
  reliably connect positional record parameters, named arguments, collection expressions,
  aliases, and asserted properties.
- Clean controls: constructors with validation or normalization; deserialization compatibility;
  rejected invalid inputs; reducer or state-machine output; equality after a real round trip;
  persisted effects; generated or captured artifacts.
- Solve: no rule now. Reconsider a consumer-native Roslyn analyzer only after the promotion gate.

### Enum Or Membership Echo

- Evidence: the expected `ImpactKind` sequence repeats the kinds used to create `touched`,
  `reached`, and `unknown`.
- Pattern: an assertion checks membership, keys, enum values, or a complete expected sequence that
  was established only by the test's own arrangement.
- Why it matters: it proves collection construction or language membership semantics instead of
  project behavior.
- Proof needed: the same semantic provenance as the constructor echo. `Assert.Contains` is not
  itself suspicious.
- Clean controls: membership after parsing, filtering, routing, state transition, authorization,
  deduplication, persistence, code generation, or artifact loading; exhaustive enum-driven behavior
  tests where each case exercises a domain operation.
- Solve: no general membership rule. Treat it as the same future non-independent-oracle analyzer,
  not a separate detector.

### Reflection Or Signature Contract Test

- Evidence: supplied as a candidate family, not observed in the Sledge hunk.
- Pattern: a test reflects over types, members, constructors, or signatures and asserts their shape
  without exercising a public compatibility requirement.
- Why it matters: internal refactors can break the test while behavior remains correct.
- Proof needed: project-owned contract provenance. Reflection syntax does not distinguish an
  internal shape guard from a valid public plugin, serializer, dependency-injection, or ABI
  contract.
- Clean controls: public API compatibility snapshots, serializer constructor requirements, plugin
  discovery, source-generated contracts, framework reflection entry points, and binary
  compatibility gates.
- Solve: reject a generic rule. Use a project-specific public-contract authority if one exists;
  otherwise keep this as review guidance.

### Source-Text Shape Test

- Evidence: the binding policy bans tests that read a source module and assert `.Contains(...)` or
  a regex over implementation text.
- Pattern: a test reads production `.cs` source and treats tokens, identifiers, or code fragments as
  the oracle.
- Why it matters: it pins implementation spelling and can pass without compiling or executing the
  behavior it claims to protect.
- Proof needed: syntax plus file provenance. The detector must distinguish production source from
  explicit fixtures, generated artifacts, packed outputs, configuration, snapshots, and golden
  files.
- Clean controls: tests of generated output, package contents, public CLI JSON, applied config,
  compiled metadata, explicit fixture text, and real artifact invariants.
- Solve: retain the existing consumer guidance. If Sledge sees a recurrence, its local architecture
  gate is the narrowest current enforcement surface; do not widen that gate to constructor or
  membership dataflow.

## Ecosystem Findings

| Tool                     | Coverage                                                                                                                                                                                                                                                                                                                                                                                     | Decision                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xunit.analyzers`        | Maintained and already distributed with current xUnit packages. Its assertion rules check correctness and idiomatic assertion APIs. `xUnit2017` replaces `Enumerable.Contains` inside `Assert.True` with `Assert.Contains`; `xUnit2030` replaces `Where(...)+Assert.NotEmpty` with `Assert.Contains`. Neither asks whether the collection or expected member came from the test arrangement. | Keep as baseline coverage. It is adjacent, not an answer to non-independent oracles. Do not interpret its membership recommendations as a membership ban.                                                       |
| Microsoft .NET analyzers | The SDK analyzers cover C# quality, design, performance, and correctness. The published first-party surface does not include a test-oracle provenance rule.                                                                                                                                                                                                                                  | Keep enabled in consumers. No relevant rule to configure.                                                                                                                                                       |
| Sonar C#                 | The C# `tests` catalog has nine rules. `S2699` checks that tests include assertions; other entries cover signatures, ignored tests, assertion completeness and argument order, sleeps, and literal booleans. A constructor echo has assertions, so it passes this layer.                                                                                                                     | Enable the maintained C# test rules in the scanner-owned profile, especially `S2699`, but record this example as an accepted gap rather than claiming coverage.                                                 |
| Roslynator               | Maintained C# Roslyn analyzer suite with no published test-oracle or assertion-provenance rule found in its analyzer surface.                                                                                                                                                                                                                                                                | No configuration solves the example. Do not add it solely for this smell.                                                                                                                                       |
| Meziantou.Analyzer       | Maintained broad C# analyzer suite with no published test-oracle or assertion-provenance rule found in its current rule list.                                                                                                                                                                                                                                                                | No configuration solves the example. Do not add it solely for this smell.                                                                                                                                       |
| ReSharper                | The 2026.1 unit-test inspection list has many NUnit checks but only one xUnit-specific inspection, for console output.                                                                                                                                                                                                                                                                       | Useful IDE tooling, but not portable build enforcement and not coverage for this invariant.                                                                                                                     |
| Semgrep                  | C# parsing is maintained and C# rules can be authored. Pattern and local dataflow rules could inventory assertion shapes, but a syntax-oriented rule would not establish the record-constructor/property relationship with Roslyn's symbol fidelity.                                                                                                                                         | Do not add a name- or syntax-pattern rule. It would either miss aliases and records or overreport valid boundary and reducer assertions.                                                                        |
| ast-grep                 | CSharp is a built-in language, but its rule language is deliberately simpler than a general-purpose semantic analyzer.                                                                                                                                                                                                                                                                       | Suitable for syntax-only C# inventory, not this value-provenance invariant. Do not add a matcher family for assertion method names.                                                                             |
| Custom Roslyn analyzer   | Technically capable. A NuGet analyzer runs in IDE and build, can resolve xUnit symbols, inspect `IOperation`, and report through the normal compiler diagnostic pipeline; SonarScanner for .NET imports third-party Roslyn diagnostics.                                                                                                                                                      | Correct future host if evidence warrants it, but not justified now. It would be a new Antidrift language and packaging surface requiring explicit policy scope, real C# corpus evidence, and consumer fixtures. |

Official sources checked:

- xUnit analyzer catalog: https://xunit.net/xunit.analyzers/rules/
- xUnit membership assertion guidance: https://xunit.net/xunit.analyzers/rules/xUnit2017 and
  https://xunit.net/xunit.analyzers/rules/xUnit2030
- Microsoft Roslyn analyzer overview:
  https://learn.microsoft.com/en-us/visualstudio/code-quality/roslyn-analyzers-overview
- Sonar C# test rules: https://rules.sonarsource.com/csharp/tag/tests/
- Sonar C# assertion-presence rule: https://rules.sonarsource.com/csharp/RSPEC-2699
- Sonar .NET analyzer and custom analyzer integration:
  https://github.com/SonarSource/sonar-dotnet
- Roslynator: https://github.com/dotnet/roslynator
- Meziantou.Analyzer: https://github.com/meziantou/Meziantou.Analyzer
- ReSharper unit-test inspections:
  https://www.jetbrains.com/help/resharper/Maintain_Code_Quality_of_Unit_Tests.html
- Semgrep C# support: https://semgrep.dev/blog/2021/announcing-csharp-ga/
- ast-grep language support: https://ast-grep.github.io/reference/languages.html
- ast-grep rule-language boundary: https://ast-grep.github.io/guide/api-usage.html

## Why Antidrift Does Not Implement This Now

The current custom rule engine is ESLint plus `typescript-eslint`; its semantic adapters depend on
TypeScript `Program` and `TypeChecker`. The package's only non-ESLint source-lint exception is an
opt-in shell ast-grep pack. `docs/source-ledger.md` assigns other non-TypeScript language linting to
native tools in consuming repositories and warns against broadening the package into a
multi-language runner without explicit policy scope.

An Antidrift policy script would also be the wrong proof layer for constructor and membership
echoes. A script that searches assertion names or test filenames would recreate the forbidden
syntax-only shortcut. The required facts are semantic:

1. the method is an xUnit test by resolved attribute symbol;
2. the invocation is an xUnit assertion by resolved method symbol;
3. the asserted receiver comes from a local object or record construction;
4. the asserted property or collection element originates from a specific constructor argument;
5. no behavior-bearing call or boundary operation produced the asserted value.

That is Roslyn analyzer work. It is not a TypeScript rule translation and should not be hidden in a
shell policy script.

## Sledge Integration Recommendation

No Sledge change is part of this investigation.

The concrete handoff is:

1. Keep the current xUnit analyzer baseline. It catches assertion misuse but does not solve this
   example.
2. Enable the maintained Sonar C# test rules in the scanner-owned quality profile, including
   `S2699`. Document that assertion presence is a lower floor than oracle independence.
3. Keep the repository instruction that tests protect deterministic replay, serialization,
   boundary rejection, locomotion, and player-visible outcomes, and that tests must not read source
   files to assert code shape.
4. For a test like the removed example, replace property and membership echoes with a domain
   operation: validation rejection, world construction, proposal inspection through `Session.Step`,
   serialization round trip, or a real fixture boundary.
5. Do not add a blanket ban for `Assert.Contains`, `Assert.All`, `Assert.NotEmpty`, reflection, record
   construction, or enum assertions.
6. If production-source text guards recur, add a narrow Sledge-local architecture check with
   fixture and artifact exclusions. Do not use it as a proxy for constructor or membership
   provenance.

## Promotion Gate For Future C# Enforcement

Reopen a Roslyn analyzer investigation only when all of these are true:

1. At least two independent C# repositories contain accepted, remediated non-independent-oracle
   examples that were not created for the rule.
2. The examples map to the existing `antidrift/no-nonindependent-test-oracle` invariant without
   inventing a C#-only smell family.
3. Real clean controls cover constructor validation, serializer compatibility, boundary rejection,
   reducer output, persistence, generated artifacts, public reflection contracts, and membership
   after behavior.
4. The proof uses resolved xUnit and constructor/property symbols plus Roslyn operations, not names,
   test-path regexes, or assertion syntax alone.
5. A C# analyzer package and consumer integration are explicitly accepted as an Antidrift product
   surface.
6. Positive and negative analyzer fixtures execute the diagnostic against compiled test programs;
   no source-file `.Contains(...)` guard test is used to test the rule itself.

Until then, the correct result is an explicit accepted gap: maintained tools enforce test execution
and assertion correctness, while oracle independence remains guidance and review evidence in C#.
