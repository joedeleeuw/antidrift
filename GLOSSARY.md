# Antidrift

Deterministic static-analysis and policy governance that makes agent-authored code fail fast when it forks canonical types, bypasses untrusted boundaries, or fabricates type authority.

## Language

### Drift & Type Authority

**Drift**:
Code that diverges from an established owner's types, contracts, state lifecycles, or architectural seams instead of composing from the owner directly.
_Avoid_: Slop, lint smell, style violation

**Appeasement**:
A cast, type erasure, redundant annotation, or reshaped wrapper introduced solely to silence a compiler or validator error without establishing runtime or type-level proof.
_Avoid_: Workaround, type hack, suppression

**Owned Contract**:
A canonical schema, generated type, or exported domain type defined by the module that owns a concern and consumed directly by callers.
_Avoid_: Shared DTO, interface copy, shadow schema

**Structural Type Fork**:
A locally declared interface, type alias, or inline object type that restates the shape of an Owned Contract from a dependency or generated source instead of importing or deriving from it.
_Avoid_: Duplicate interface, parallel type, clone shape

**Canonical Model**:
A first-party domain entity or status union declared in the project's domain registry as the single authoritative representation of that concept.
_Avoid_: Base model, shared entity, common type

**Service Tag**:
An exported dependency-injection token or layer declaration through which callers must resolve a capability rather than importing and invoking its raw constructor function.
_Avoid_: Service helper, factory wrapper, DI container

### Untrusted Boundaries & Provenance

**Untrusted Boundary**:
An entry point where external input enters the system—such as network responses, persisted storage, environment payloads, URL parameters, or raw deserialization—and must be decoded by an Owned Contract before domain use.
_Avoid_: Edge layer, API border, input handler

**Broad Input**:
A value typed as `unknown`, `any`, `object`, `{}` or an open dictionary whose runtime shape has not yet been established by a decoder or Narrowing Proof.
_Avoid_: Untyped value, loose input, dynamic payload

**Narrowing Proof**:
Control-flow or type-predicate evidence showing that every constituent of a Broad Input has been checked before a narrower type claim is made.
_Avoid_: Type guard heuristic, safety comment, runtime check

**Provenance**:
The traced origin of a value, type, or symbol across bindings, calls, and module imports—establishing which decoder produced a value, which package owns a symbol, or how a SQL fragment or React state cell was constructed.
_Avoid_: Lineage, taint, heuristic match

**Semantic Fact**:
A structured, machine-readable record emitted by a rule when it proves a semantic relationship—such as a structural match against an Owned Contract, an underchecked predicate, or a coupled state transition.
_Avoid_: Warning log, telemetry event, debug trace

### Rule Engine & Verification

**Semantic Kernel**:
The unified TypeScript-native rule execution model and shared Semantic Primitives that operate directly on compiler AST nodes and type checker state rather than linter-specific syntax wrappers.
_Avoid_: Plugin utils, rule helpers, AST bridge

**Semantic Primitive**:
One of the five core analysis capabilities in the Semantic Kernel: Shape Identity, Symbol & Package Surface Provenance, Boundary & Narrowing Dataflow, Program Call-Graph & Evaluation Order, and Domain Provenance Graphs.
_Avoid_: Shared utility, rule helper, common analyzer

**Validation Gate**:
The blocking repository check that requires every active rule to be enabled at error severity with zero findings across the self-hosted workspace and zero stale baseline suppressions.
_Avoid_: Lint check, smoke script, CI step

**Real-Corpus Gate**:
Verification of rule precision and recall against pinned, unmodified external production repositories where every expected drift site, clean control, and known gap is explicitly accounted for.
_Avoid_: Unit test suite, synthetic benchmark, fixture test

### Codebase Design

**Module**:
Any unit with an Interface and an Implementation, from a single function or semantic analyzer to a published package.
_Avoid_: Component, service, unit, helper file

**Interface**:
Everything a caller must know to use a Module correctly: its type signature, invariants, required configuration, and failure modes.
_Avoid_: API, function signature

**Implementation**:
The internal code and private seams inside a Module that fulfill its Interface.
_Avoid_: Internals, business logic

**Seam**:
The location where a Module's Interface lives and where behavior can be exercised, tested, or substituted without editing the implementation behind it.
_Avoid_: Boundary, hook point, abstraction layer

**Adapter**:
A concrete implementation that satisfies an Interface at a Seam, such as an ESLint or Oxlint host runner wrapping the Semantic Kernel.
_Avoid_: Wrapper, shim, bridge

**Depth**:
The leverage a Module provides at its Interface: how much semantic analysis or behavior a caller gets per unit of interface complexity they must learn.
_Avoid_: Size, lines of code, abstraction level

**Leverage**:
The capability callers and rules gain when one deep Module implementation pays back across many rules and corpora.
_Avoid_: Reuse, DRY

**Locality**:
The property where changes, invariants, and bug fixes for a concern concentrate inside one owner Module rather than scattering across callers.
_Avoid_: Cohesion, encapsulation
