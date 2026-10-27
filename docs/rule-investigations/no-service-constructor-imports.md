# no-service-constructor-imports

Report imports of a raw service constructor or factory from a module that owns an Effect service contract, unless the import is used only to wire a Layer.

## Problem & Why Naming Heuristics Failed

Vendored `anti-slop` included a syntax-only `no-service-constructor-imports` rule that banned any relative import whose identifier matched `^make[A-Z]`. That heuristic failed on real TypeScript codebases because `make*` is a general functional constructor convention (for example `makeUrl`, `makeCacheKey`, `makeError`) rather than evidence of a dependency-injection Service Tag bypass. The syntax-only rule was retired in `0.16.0` until a TypeChecker-backed proof was built.

## Semantic Proof

Built on `defineTypeScriptRule` (`src/semantic-adapters/kernel/rule-kernel.ts`) and module/symbol resolution, `antidrift/no-service-constructor-imports` proves two facts using `ts.TypeChecker` before reporting:

1. **The imported module owns an Effect service contract:**
   - The target is a first-party source module with a Service Tag or Layer. Supported tag forms include `Context.Tag`, `Context.GenericTag`, `Context.Service`, `Effect.Tag`, and `Effect.Service`.
2. **An imported callable returns the service implementation:**
   - The callable's return type, or the success type of its returned `Effect`, is assignable to a non-empty service shape. Shapes come from local tag declarations and from the type of the tag supplied to Layer construction, so immutable imported aliases preserve the contract.
   - TypeScript assignability permits additional implementation members. Unknown or empty service shapes do not certify a constructor.
   - Being referenced by Layer wiring is not constructor evidence. Helpers such as request-location and error-mapping functions remain clean when their return type does not implement the service.

## Scope & Exemptions

- **Layer wiring:** An imported constructor used only inside Layer construction is allowed, including a constructor imported alongside the service tag.
- **Test files:** Recognized test filenames and test directories are exempt; there is no `allowInTests` rule option.
- **Pure data factories:** A module without a Service Tag or Layer does not trigger the rule, regardless of whether its exported functions are named `make*` or `create*`.
