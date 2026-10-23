# no-first-party-module-mock

Disallow test module mocks of first-party modules, which make the test's assertions check the replacement instead of the module.

The rule resolves the specifier passed to `vi.mock`, `vi.doMock`, `jest.mock`, `jest.doMock`, `jest.setMock`, `jest.unstable_mockModule` or a `mock.module` imported from `bun:test`, using the linted program's compiler options, so tsconfig `paths` aliases resolve. It reports when the resolved file lies outside `node_modules`. A workspace package linked into `node_modules` resolves to its real path in the repository and counts as first-party. A third-party package or platform module stays under `node_modules` and is the boundary a test may replace. A specifier that does not resolve, or is not a string literal or `import()` of one, is not reported. A partial mock built from `importOriginal` still replaces the module for every importer and reports.

## Evidence

The retired anti-slop `no-module-mocking` rule reported every module mock. In the labelled sample of its hits from BuilderIO/agent-native, cloudflare/agents and LibreChat, 7 of 9 mocked a first-party module and were labelled drift: persistence and data-hook seams, a project class that wraps a vendor SDK, and a stubbed child component whose test id the assertions then checked. The other 2 mocked third-party SDKs (`@x402/core`, `partysocket`) while the code under test ran for real, and were labelled not drift.

Run on those files, this rule reports every mock in the drift files it can parse (`voice-providers/telnyx/tests/helpers/transport-config.test.ts`, `ShareView.highlight.spec.tsx`, `PinnedSection.spec.tsx`, `TokenUsage/index.spec.tsx`) and nothing in `x402.test.ts`. `useVoiceAgent.test.tsx` belongs to no tsconfig, so no type-checked rule runs on it.

`antidrift/no-nonindependent-test-oracle`, named as the replacement when the anti-slop rule was retired, reports nothing in `transport-config.test.ts` or `ShareView.highlight.spec.tsx`, and 17 times in `x402.test.ts`, which mocks only third-party SDKs.
