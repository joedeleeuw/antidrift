# no-service-constructor-imports

Report imports and direct invocations of a raw service constructor or factory function from outside the module that defines and exports its Service Tag or Layer.

## Problem & Why Naming Heuristics Failed

Vendored `anti-slop` included a syntax-only `no-service-constructor-imports` rule that banned any relative import whose identifier matched `^make[A-Z]`. That heuristic failed on real TypeScript codebases because `make*` is a general functional constructor convention (for example `makeUrl`, `makeCacheKey`, `makeError`) rather than evidence of a dependency-injection Service Tag bypass. The syntax-only rule was retired in `0.16.0` until a TypeChecker-backed proof was built.

## Semantic Proof (`0.17.0+`)

Built on `defineTypeScriptRule` (`src/semantic-adapters/ts-rule-kernel.mjs`) and Symbol & Module Provenance (`resolveAliasedSymbol`, `symbolDeclarations`), `antidrift/no-service-constructor-imports` proves two facts using `ts.TypeChecker` before reporting:

1. **The target module owns an exported Service Tag or Layer:**
   - The defining `ts.SourceFile` exports a symbol whose type or initializer is an Effect `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service`, or `Layer.Layer` (or a class/const declaration extending/initializing a Service Tag).
2. **A non-owner module imports and invokes the raw constructor/factory directly:**
   - The current `ts.SourceFile` is not the defining module, and it imports a value function from that defining module whose return type produces the service implementation or `Effect` of the service implementation (rather than the Service Tag or `Layer` itself), instead of resolving the capability through its exported Service Tag or Layer.

## Scope & Exemptions

- **Same-module wiring:** Calling `makeUserService` inside the defining module that constructs `UserServiceLive = Layer.effect(UserService, makeUserService)` is allowed because the owner module is wiring its Layer.
- **Test files:** Exempt when `allowInTests: true` (default `true`) so unit harnesses that instantiate the raw implementation directly are not blocked unless configured with `allowInTests: false`.
- **Pure data factories:** Modules that do not export a Service Tag or Layer never trigger the rule, regardless of whether their exported functions are named `make*` or `create*`.
