# `no-raw-react-native-touchables`

## Original failure mode

Murderbox had one intended interaction authority but 140 production `Pressable` call sites, raw React Native imports, a legacy `TouchableHighlight` wrapper, and feedback encoded independently through active class strings and functional pressed-state rendering. That made ordinary button behavior capable of drifting across iOS, Android, browser web, and Electron even though the product intended one shared renderer and one native-backed interaction policy.

The repaired construction owns ordinary interactions in one app module. It exports an RNGH 3 `Touchable` with required named feedback presets and a narrow router-link adapter. Feature modules do not import React Native or RNGH touchable primitives directly.

## Signal and scope

The import or re-export syntax is the policy violation. The rule requires no type information and reports:

- named and aliased imports of React Native `Pressable` and legacy touchables;
- RNGH `Touchable`, `Pressable`, legacy touchables, and legacy button primitives;
- namespace or default imports from either package because they bypass named-import enforcement;
- named and namespace re-exports from either package.

`allowedFiles` contains exact repository-relative owner paths with at least one directory segment and no glob, parent, or absolute-path syntax. Each entry matches either the whole normalized filename or that fully qualified repository-relative suffix. The rule does not infer owners from component names and does not allow feature-level exceptions. A legitimate router-link or custom-gesture exception belongs behind a narrow app-owned adapter in a registered owner file.

## Desired replacement

Import the shared `Touchable`, choose a named feedback preset, and preserve semantic action behavior at the call site. Router links and genuinely custom gestures should use a narrow app-owned adapter rather than a raw primitive import.

## Ecosystem comparison

Oxlint's core `no-restricted-imports` can express named import restrictions and file overrides. It remains the closest config replacement. This custom rule keeps ownership because the reusable policy spans two packages, a maintained forbidden primitive set, namespace/default bypasses, re-exports, exact owner-file registration, and one remediation message describing feedback presets and adapter ownership. If core configuration gains an equally maintainable shared policy surface, retire the custom implementation rather than running both.

## Real corpus evidence

Murderbox is the first real corpus:

- drift: 138 `@/tw Pressable` call sites, two direct React Native Pressables, and an unused legacy `TouchableHighlight` wrapper;
- clean owner: `apps/client/src/tw/index.tsx` imports React Native `Pressable` only for `RouterLinkPressable` and imports RNGH `Touchable` for the shared primitive;
- clean consumers: production feature files import `Touchable` or `RouterLinkPressable` from `@/tw` and contain no raw touchable primitive imports;
- clean adjacent APIs: React Native `View` and RNGH `Gesture` imports remain accepted.

## Known boundaries

- Type-only imports and re-exports are accepted because they cannot render or expose a runtime interaction primitive.
- Dynamic `import()` and CommonJS `require()` are not covered because Murderbox's TypeScript baseline already rejects require imports and no real dynamic-import bypass was found.
- Deep package subpath imports are not covered. Murderbox already prohibits unowned package internals and no real touchable subpath bypass was found.
- Namespace imports are intentionally rejected even if their current member usage is clean; once a target package namespace is available, touchable ownership can drift without another import declaration. Their diagnostic first asks for named non-interaction imports, then gives the shared `Touchable` path for touch targets.
- The rule is default-off in Antidrift and should be enabled only by consumers that have established one app-owned interaction module and registered its exact owner file.

## Validation

Real Oxlint execution covers aliased imports, namespace imports, named re-exports, namespace re-exports, type-only imports, clean adjacent imports, exact owner-file allowance, and rejection of underqualified owner paths. Murderbox typechecks and renderer lint for iOS, Android, and web, its full Vitest suite, web export, and deterministic renderer export are the consumer migration evidence.

## Advisory review

A Claude Opus 4.8 read-only advisory returned **ship default-off/ready; block only stable promotion**. It confirmed alias and re-export handling plus the custom delta over core restricted-import configuration. Its actionable findings were applied before completion: type-only forms are now accepted, namespace/default remediation distinguishes named non-interaction imports from touch targets, and owner-file tests require a fully qualified repository-relative path. Deep subpaths, dynamic imports, CommonJS, and independent-repository replication remain documented stable-promotion boundaries.
