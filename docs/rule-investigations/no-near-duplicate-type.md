# no-near-duplicate-type

Report a local object type that repeats most of the fields of another object type its module can already import, so the author derives it from that owner (use it as is, `Pick`/`Omit`, `extends`, or a shared base) instead of keeping a parallel copy.

## What the rule compares

The rule indexes, once per TypeScript program and package (the nearest `package.json` directory), every interface, every type alias of an object literal and every object literal written as a parameter type, outside declaration files and installed dependencies. An interface contributes its own members only; inherited members are already reused. A member written as `never` or `undefined` marks an exclusive union arm, not a field, and is dropped. Each indexed type needs three members. An inverted index on member names finds the candidates of a local type, so the cost follows the members that actually repeat rather than the square of the number of types.

A local type and a candidate in the same package form a pair when all of these hold:

- they share at least three member names, covering at least 80% of the smaller type, with a Jaccard index (shared names over all names) of at least 0.45;
- every shared member has the same checker type. Types compare through `semantic-adapters/shape/shape-identity.ts`, the matcher of `no-inline-structural-type-at-use-site`; an optional `x?: T` and a required `x: T | undefined` count as the same field type, and the optionality difference goes into the advice;
- neither extends the other, directly or through further interfaces, neither contains the other, and they are not two declarations of one merged interface;
- they are connected: declared in the same module, or one module imports the other. Imports resolve through the checker, re-export barrels included (`semantic-adapters/provenance/module-imports.ts`).

The owner is the side the other already depends on: the declaration whose module the local type's module imports. Within one module, or two modules that import each other, a named type owns a shape over an inline parameter type, a signature's parameter (an interface method, a function type, an overload) over an implementation's, an exported type over a private one, and an earlier declaration over a later one. A pair therefore reports once, at the copy.

A local type with several owners reports once, naming one owner: a decided comparison over an undecided one, an exact copy over a near one, then the strongest connection (the module imports the owner by name, then the same module, then a module import), then the larger Jaccard index, then the earlier owner. The labels that set the gate showed several smaller types copying a third type rather than their best-overlap partner, which is why the connection ranks before the overlap.

The message names the owner and its file and line, says how many of the owner's fields repeat, and gives the concrete derivation: the owner itself for an exact copy, `Pick<>` or `Omit<>` for a subset (wrapped in `Required<>` or `Partial<>` when every shared field ends up required or optional, otherwise with the changed fields picked again), `extends` for a superset, and a shared base for an overlap. An unnamed owner, a parameter's object type, is described by its parameter and function, and the advice is to name it once.

A member type that does not resolve (the compiler's error type, or `any` reached through a written type reference rather than written as `any`) makes the comparison undecided. When no decided owner exists, the rule reports the site as incomplete analysis (`undecided`) and names the unresolved reference, never as a match or a difference.

## Division of labour with the exact-copy rules

`no-inline-structural-type-at-use-site` owns exact repeats in boundary parameter types. Before reporting a parameter type, this rule asks that rule whether it reports the same literal, and leaves the site to it when it does; the two rules therefore cannot disagree about the boundary scope. `no-restated-dependency-type`, `no-structural-type-fork` and `no-canonical-model-fork` compare against owners in other packages, generated sources or configured domain models; this rule's owners are first-party types of the same package.

## Evidence that set the gate

A prototype on the TypeScript checker paired each object type with an importable type sharing at least three member names covering at least 80% of the smaller type. Pairs were labelled by reading the code (one should be expressed through the other, or both through a shared owner, versus legitimately separate). Within the gate "same workspace package, no differing member types, Jaccard of at least 0.45", 31 of 32 out-of-sample pairs (opencode, LibreChat) and 14 of 14 in-sample pairs (cloudflare/agents) were real duplicates; the 0.45 threshold was read off the out-of-sample labels only.

The labels also showed that real duplicates had a connection between the two declarations, an import or a value passing between them, and named the noise left inside the gate: context arguments threaded through sibling helpers, identity fields shared by unrelated entities, sibling parser models, an event against a stored record, SQL row projections against domain models, and union arms whose fields are typed `never`. Test files held real copies of production types, so tests stay in scope.

The 46 labelled pairs inside that gate show what the module connection costs: 20 sit in one module, 18 in two modules of which one imports the other (one of them through a re-export barrel), and 8 in two modules neither of which imports the other. Those 8 are real duplicates whose connection runs through a third module (a value of one type passed where the other is expected, in a module that imports both) or through a third type both copy. The rule requires the module connection, so it misses them; counting a connection through a third module would need a program-wide value-flow index.

## Measurement

Four repositories with dependencies installed: opencode, LibreChat, cloudflare/agents and agent-native. Each was linted on a seeded random sample of 300 of its TypeScript files (seed 20261022, the eligible files exclude `node_modules`, build output, generated and fixtures directories, declaration files and dot-directories), grouped by nearest `tsconfig.json`, one 4 GB-heap ESLint process per group, one repository at a time. Files that no tsconfig includes fail to parse and are not counted as linted: 1,094 of the 1,200 sampled files were linted (opencode 300, LibreChat 281, agents 287, agent-native 226). The rule ran beside `no-inline-structural-type-at-use-site` and `no-redundant-local-return-type`; opencode's `packages/ai` group exceeded the 4 GB heap with all three, so its 61 files ran with this rule alone.

### Volume

| Repository        | Sampled | Linted | Decided reports | Undecided reports | Decided per 1,000 linted files |
| ----------------- | ------: | -----: | --------------: | ----------------: | -----------------------------: |
| opencode          |     300 |    300 |               5 |                 0 |                           16.7 |
| LibreChat         |     300 |    281 |               9 |                 4 |                           32.0 |
| cloudflare/agents |     300 |    287 |              18 |                 3 |                           62.7 |
| agent-native      |     300 |    226 |              20 |                 3 |                           88.5 |
| All               |   1,200 |  1,094 |              52 |                10 |                           47.5 |

Eleven of the agents reports sit in one 10,000-line test agent (`packages/think/src/tests/agents/think-session.ts`), which restates private agent types and the parameters of private methods it reaches through casts. The undecided reports all name a type imported from an unbuilt workspace package (`librechat-data-provider`, `agents/chat`). `no-inline-structural-type-at-use-site` reported 19 sites in the same samples; no site was reported by both rules.

### Precision

The label sample takes every decided report of the four samples whose local or owner file the prototype labels did not name, capped at 10 per repository: 4 in opencode, 8 in LibreChat, 5 in agents and 10 of 20 in agent-native. Each was judged by reading both declarations and how values of them are produced and consumed, with the prototype's definition: real when one type should be expressed through the other, or both through a shared owner.

25 of 27 are real (92.6%, Wilson 95% interval 76.6–97.9%): opencode 4/4, LibreChat 8/8, agents 4/5, agent-native 9/10. Two real calls are borderline shared-base cases; counting them false gives 23/27 (85.2%).

| Repository   | Reported type                               | Owner                                     | Verdict                                                                                      |
| ------------ | ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| opencode     | `ViewDiff` (session-ui `session-diff.ts`)   | `PresentationFileDiff`                    | real: `normalize` copies four of its fields                                                  |
| opencode     | `DialogErrorDetails` props (tui)            | `errorDetails` input                      | real: the props are passed whole to `errorDetails`                                           |
| opencode     | `LegacyDiff` (session-ui)                   | `PresentationFileDiff`                    | real: equals `PresentationFileDiff & { file: string }`, already a union arm in the same file |
| opencode     | mistral `PendingTool`                       | `ToolAccumulator`                         | real: the shared streamed tool-call accumulator                                              |
| LibreChat    | `ArtifactTabsProps`                         | `SandboxArtifactTabs` props               | real: spread whole into the lazy component                                                   |
| LibreChat    | `createCodeBridgePairing` options           | `getCodeBridgeWorkerStatus` options       | real: one worker-request base                                                                |
| LibreChat    | `TScheduleRun`                              | `TScheduleLastRun`                        | real: the last run is projected from the run row                                             |
| LibreChat    | `fetchStatus` params (code bridge poller)   | the poller's request params               | real: passed down without `bypassCache`                                                      |
| LibreChat    | `buildMCPAuthToolCall` input                | `OAuthToolCall`                           | real: builder input copied into the built object                                             |
| LibreChat    | `observe` params                            | `fetchStatus` params                      | real: forwarded whole                                                                        |
| LibreChat    | `buildMCPAuthRunStepCompletedEvent` input   | `buildMCPAuthRunStepEvent` input          | real, borderline: one step descriptor for start and completion                               |
| LibreChat    | test `ActiveRun` (schedules)                | `abortActiveRun` run                      | real: a test copy of `IScheduleRun` rows that reach `abortActiveRun`                         |
| agents       | test `Tab` (browser session connector)      | `BrowserNewTab`                           | false: a fake DevTools target record against the report entry built from such records        |
| agents       | `PiImagesCallOptions`                       | `PiImagesModelOptions`                    | real: the same six image settings per call and per model                                     |
| agents       | `FileInit` (shell)                          | `FileEntry`                               | real: the init input of a file entry                                                         |
| agents       | MCP manager `connect` options               | `MCPClientConnection` constructor options | real: passed into the constructor                                                            |
| agents       | web-fetch-lab sidebar props                 | `UrlLabSidebar` props                     | real: sibling sidebars, shared base                                                          |
| agent-native | `ExecuteSandboxCodeResult`                  | `SandboxExecutionRunOutput`               | real: exact copy of the runner output                                                        |
| agent-native | `PlanPrototypeTransition`                   | `PlanDiagramEdge`                         | false: a sibling block's edge with its own schema limits                                     |
| agent-native | `PlanConnector`                             | `PlanDiagramEdge`                         | real: identical type and identical zod schema                                                |
| agent-native | `isActionHiddenFromEveryAgentSurface` entry | `isActionExposedToExternalAgents` entry   | real: both copy the action entry's flags                                                     |
| agent-native | `FailOptions`                               | `ActionContractErrorOptions`              | real: `fail` fills a default and passes them on                                              |
| agent-native | `SendReviewThreadToAgentInput`              | `SetReviewThreadUnreadInput`              | real, borderline: one thread reference across operations                                     |
| agent-native | `ResolvedInboxTab`                          | `SavedMailFilter`                         | real: tabs copy each saved filter's fields                                                   |
| agent-native | `ActionMcpAppHtmlBuilder` context           | `ActionMcpAppCspBuilder` context          | real: one MCP app context                                                                    |
| agent-native | `ReadinessPanel` props                      | `readinessItems` input                    | real: passed through                                                                         |
| agent-native | `AgentRunState` (agentkit client)           | `AgentRunSnapshot`                        | real: the protocol snapshot without `threadId` and `metadata`                                |

Reading the reports also corrected the advice: `Required<>` and `Partial<>` now wrap the derivation only when every shared field agrees, otherwise only the flipped fields are picked again; an owner or local interface with an `extends` clause gets a `Pick<>` rather than `Omit<>` or the owner itself, because its inherited members are not part of the comparison; and an owner that is the parameter of a constructor or of an unnamed function is named by its class or enclosing declaration.

### Cost

ESLint's per-rule timing (wall-clock time in each rule's listeners, on a machine shared with other measurement runs) for the final code on the opencode, LibreChat and agents samples, 807 linted files. opencode's `packages/ai` group is left out, because it exceeded the 4 GB heap with three rules in one process.

| Rule                                    | opencode (239 files) | LibreChat (281) | agents (287) | Per 1,000 linted files |
| --------------------------------------- | -------------------: | --------------: | -----------: | ---------------------: |
| `no-near-duplicate-type`                |                4.9 s |           3.3 s |        2.5 s |                 13.3 s |
| `no-inline-structural-type-at-use-site` |               14.0 s |          10.9 s |        2.2 s |                 33.5 s |
| `no-redundant-local-return-type`        |                5.5 s |           0.5 s |        0.2 s |                  7.7 s |

Before reporting a parameter type, this rule asks `no-inline-structural-type-at-use-site`, which builds that rule's program index the first time it is asked. In the three groups where this rule took more than a second (opencode `packages/tui`, LibreChat `packages/api`, the agents think tests) the other rule's own time was 4–9 ms, so its index was built inside this rule's time. Without those three groups (704 files) this rule took 2.1 s, 3.0 s per 1,000 files. With both rules enabled, as in the preset, the index is built once either way.

A CPU profile of this rule alone on opencode's `packages/core` (42 sampled files of a 753-file package) measures 0.50 s: 0.18 s to index the package and 0.31 s for the checker to resolve the member types of compared pairs. Skipping subtrees without TypeScript syntax, which TypeScript marks while parsing, cut the index walk from 0.69 s to 0.14 s and the total from 1.03 s. A pair's forward import is checked before its reverse import, its heritage and its member types, so the many candidates that share names with an unconnected type stay cheap.

### Memory

The rule builds no second program. Its index holds declaration nodes and member-name maps per package, and member types resolve on demand.

- opencode `packages/app`, the full 597-file group, with an earlier version of the rule that resolved every member type up front: 4,172 MB peak RSS with no rule, 4,237 MB with this rule (+65 MB, 1.6%).
- opencode `packages/ui`, 9 sampled files: 3,353 MB with this rule alone and 3,360 MB with the three rules. Adding `no-restated-dependency-type` exhausted the 4 GB heap (4,259 MB).
- agent-native `packages/core`, 63 sampled files of a 3,202-file package: 3,673 MB with this rule alone.

The program dominates: opencode's `packages/app` needs more than 4 GB of RSS before any rule runs.

The scan logs, label notes and profiles were kept in the measuring session's scratch space and are not committed.
