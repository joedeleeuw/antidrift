# no-schema-validator-transcoding

Reject runtime-validator authority passing through another schema
representation: an Effect Schema rendered to JSON Schema and then registered
as a second runtime validator (a Convex `args`/`returns` validator).

## Intent

An Effect Schema is a runtime authority: it parses and validates values.
`JSONSchema.make` renders that schema into a JSON Schema document — a
representation meant for documentation, OpenAPI specs, and human consumers.
When the document is registered as a Convex validator, the contract gains a
second runtime owner derived through an intermediate representation. The two
owners drift silently: the JSON Schema round-trip drops refinements, branded
types, and transforms, so the registered validator accepts and produces shapes
the Effect Schema never owned.

Documentation and OpenAPI generation stay allowed: the generated
representation is rendered for humans, never executed as a runtime authority.

```ts
// drift: the JSON Schema document becomes the registration's runtime validator
const returnsDocument = JSONSchema.make(MachineRegistration);
query({ returns: returnsDocument, handler });
query({ returns: JSONSchema.make(MachineRegistration), handler });

// allowed: the JSON Schema is rendered for documentation only
buildApiDocumentation(JSONSchema.make(MachineRegistration));

// allowed: the registration keeps its own runtime owner
query({ returns: v.array(v.object({ machineId: v.string() })), handler });
```

## Signal

TypeChecker symbol resolution, never name matching:

1. Source: a call whose callee resolves through the checker to `make` declared
   in the `effect` package's `JSONSchema` module produces a JSON-Schema
   representation of a runtime validator.
2. Sink: the conversion result reaches the `args` or `returns` property of an
   object literal passed to a Convex registered function — the callee resolves
   to `query`/`mutation`/`action`/`internal*` (including the `*Generic`
   builders `convex/server` actually exports) in the `convex` package's server
   surface. The flow is direct or through a single const binding.
3. Allow: a call whose resolved callee is declared in a package whose name
   includes `openapi` is a documentation sink and never reports.

Aliased imports (`queryGeneric as query`, `JSONSchema as EffectJSONSchema`)
resolve through the checker; a locally declared function that merely shares a
name is not flagged.

## Deliberate boundaries (false negatives by design)

- Zod sources are covered since 2026-08-10: `toJSONSchema` calls whose symbol
  resolves to the `zod` package count as conversion sources, and one converter
  wrapper (handwritten or helper) between the representation and the
  registration is part of the chain. Murderbox's historical transcoder,
  `apps/client/convex/zodToConvex.ts` (zod v4-core `toJSONSchema()` into a
  handwritten `convexValidatorFromJsonSchema`), was remediated in murderbox
  commit 3a030ff4 ("make conversation Convex validators direct"); the zod
  branch now guards against reintroduction.
- Ajv and other JSON-Schema-consumer sinks stay silent; only the Convex
  registration sink is proven.
- Flows through more than one converter call, more than one const binding,
  object property carriers, or function returns stay silent.
- Registrations imported through a project-local `_generated/server` wrapper
  resolve to the project file, not the `convex` package; v1 proves direct
  `convex/server` builder imports only.

## Ecosystem check (2026-08-10)

Converter inventory: `effect@3.22.1` ships `JSONSchema.make`; the installed
`zod@3.25` exposes v4-core `toJSONSchema`; no `zod-to-json-schema` package is
present; `ajv` and `convex-helpers` are not installed in either surveyed
repository. Murderbox's one real transcoding site (zod-sourced) was remediated
in murderbox@3a030ff4; zero Effect-sourced sites exist, and Murderbox does not
depend on `effect` at all.
`@convex-dev/eslint-plugin` covers Convex file layout and argument
conventions, not cross-package schema provenance. No typescript-eslint rule
models a value's conversion history into a second validator registration.

## Corpus

- Murderbox (`apps/client`): clean-run control — zero findings across
  `convex/` and `src/`, including the real zod-sourced transcoder, which stays
  silent by design.
- Synthetic fixtures cover the direct and single-const-binding drift shapes,
  the documentation-sink allow, and registrations that keep their own
  validator owner.
