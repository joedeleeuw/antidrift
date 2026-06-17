# Test Quality Taxonomy

This document classifies the low-value tests agents tend to write. It is an
inventory and planning surface, not a blanket enforcement spec. A candidate only
becomes a blocking rule when the proof object shows the test is vacuous, not just
small, simple, or focused.

Good tests can be narrow. The failure mode here is different: the test asserts a
library happy path, a mocked contract, a source-code shape, or a hand-copied
registry instead of the project behavior that regressed.

## Candidate Categories

| Candidate policy ID | Failure statement | Likely proof surface | Potential solve type | Flag example | Counterexample / allowed shape | Promotion evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `test/no-source-shape-guard` | The test reads production source text and asserts implementation shape instead of behavior. | Local AST/source-shape proof. | `test-source-shape-guard` | `readFileSync("src/foo.ts", "utf8"); expect(source).toContain("SomeInternalName")` | Reading an explicit fixture, generated artifact, packed tarball metadata, CLI JSON output, or compiled public artifact and asserting the public contract. | Real test files where refactors break guard tests while behavior still works; clean controls for generated artifact checks and package smoke tests. |
| `test/no-library-echo-parse` | The test proves Zod, Valibot, JSON, or a framework parser accepts an obvious literal that the local schema already declares. | Semantic AST plus schema/provenance facts; TypeChecker useful for inferred schema output. | `test-schema-echo` | `expect(UserSchema.parse({ id: "1", name: "A" })).toEqual({ id: "1", name: "A" })` | Boundary tests with transforms, defaults, refinements, coercion, branded outputs, rejected bad payloads, captured external samples, or schema ownership compatibility assertions. | Real examples where the only asserted behavior is library success on an inline literal; clean controls for schema transforms and captured external payloads. |
| `test/require-regression-provenance` | A "regression" test only corrects a hand-written payload typo; it does not preserve the bug boundary or prove the previous failure. | Repo/session/corpus provenance plus semantic AST inventory. | `test-regression-provenance` | Inline invalid fixture is edited until parse passes, then the test asserts success. | Test names or metadata link to a bug, real request, captured fixture, production payload, or corpus case; assertion checks reject/normalize/route behavior that would have failed. | Corpus of post-review tests with no external sample, issue link, snapshot source, or boundary assertion; clean controls with captured fixtures. |
| `test/no-self-fulfilling-mock-contract` | The test mocks the same contract the implementation consumes, so test and code can drift together. | Semantic AST plus import/graph provenance; often advisory first. | `test-mock-contract-provenance` | Mock service returns the exact DTO shape imported from the implementation module, then the test asserts the component renders that same mocked field. | Contract test runs through the public adapter, gateway, schema parser, MSW/captured HTTP fixture, or a separately owned test builder. | Real mocks that duplicate production contracts and missed a drift; clean controls for public-boundary mocks and generated builders. |
| `test/no-registry-restatement` | The test hand-copies a registry or manifest and compares exact lists, creating a second registry. | Local AST/source-shape plus registry-source facts. | `test-registry-contract-parity` | `expect(manifest.map(x => x.id)).toEqual(["a", "b", "c"])` where the list is already owned by `rules.yaml`. | Assert invariants through public registry APIs: lookup works, required entry exists, filters compose, generated artifacts match the source registry. | Self-hosting examples where adding a valid registry row fails a stale hand-copied list; clean package smoke tests that consume the shipped CLI/API. |
| `test/no-vacuous-wrapper-smoke` | The test calls a thin wrapper with all dependencies mocked and only proves the wrapper calls the mock. | Semantic AST plus call graph; weaker without effect/output assertions. | `test-wrapper-smoke` | Mock `fetchUser`, call `loadUser`, assert `fetchUser` was called once, with no output/error/cache assertion. | Wrapper has policy behavior: auth headers, retries, timeout, normalization, error mapping, cache keys, tracing, or schema validation. | Real tests that survived broken wrapper behavior; clean controls for wrappers with observable policy. |
| `test/no-uninterpreted-snapshot` | A large snapshot or inline object is treated as proof without naming the behavioral contract. | AST/source-shape inventory; blocking proof is hard. | `test-snapshot-semantics` | `expect(rendered).toMatchSnapshot()` as the only assertion for a complex branch. | Snapshots for stable render output paired with semantic assertions, visual baselines, or generated artifacts whose source is explicit. | Review corpus showing snapshots masking behavior drift; clean controls for small golden artifacts and paired semantic assertions. |

## What Semantic AST Can Prove

Some categories can become deterministic rules:

- `test/no-source-shape-guard`: source file read plus textual assertion on production source is a strong local AST proof.
- `test/no-registry-restatement`: exact-list assertions against data already owned by a registry are detectable when the registry source is known.
- Narrow branches of `test/no-library-echo-parse`: inline literal, local schema parse, and only success/equality assertions are detectable. Blocking should exclude transforms, defaults, refinements, coercions, brands, reject cases, and captured external samples.

Other categories are mostly inventory until they gain provenance:

- `test/require-regression-provenance` needs evidence that the payload came from a real bug, external sample, copied failing case, or corpus row.
- `test/no-self-fulfilling-mock-contract` needs ownership facts to distinguish useful public-boundary mocks from mocks that mirror implementation internals.
- `test/no-uninterpreted-snapshot` usually needs review judgment unless the snapshot is the only assertion and there is no artifact/golden source.

LoRA/RL-style classifiers may rank ambiguous tests for review, but they should not be the enforcement floor. The enforceable surface is deterministic semantic facts plus optional corpus provenance. A model can say "this smells like a pointless regression"; a rule must say what proof object made it pointless.

## Example Inventory Format

Each candidate should keep real examples in this shape before implementation:

| Candidate | Repo/path | Kind | Evidence | Expected rule decision | Replacement pattern |
| --- | --- | --- | --- | --- | --- |
| `test/no-library-echo-parse` | `repo/path/user-schema.test.ts` | drift | Inline literal matches schema; only asserts parse success. | Report or inventory, depending on transform/refinement exclusions. | Assert rejected bad payload, transform/default output, or parse a captured boundary sample. |
| `test/no-library-echo-parse` | `repo/path/user-schema.test.ts` | clean | Schema has `.transform` and assertion checks transformed output. | No report. | Keep. |
| `test/require-regression-provenance` | `repo/path/route.test.ts` | drift | Test name says regression but fixture has no external source and assertion only checks happy-path parse. | Inventory until provenance policy exists. | Store captured sample or assert the boundary behavior that failed. |
| `test/no-registry-restatement` | `repo/path/manifest.test.ts` | clean | Test invokes public CLI and checks lookup/filter invariants. | No report. | Keep invariant assertions; avoid hand-copied full lists. |

## Validation Requirements

Before any category moves from taxonomy to active custom rule:

1. Record at least one real drift example and one real clean counterexample.
2. Name the smallest proof object: source shape, semantic schema provenance, registry ownership, graph/import fact, or corpus provenance.
3. Define the no-report cases first, especially schema transforms, captured external fixtures, generated artifacts, and public package smoke tests.
4. Prefer ecosystem rules for generic test integrity (`.only`, skipped tests, conditional assertions, missing assertions). Keep Antidrift focused on agent-specific vacuity and provenance failures.
5. Keep fixture strings as regression locks only after the real examples are recorded.
