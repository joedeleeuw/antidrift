# Redundant Local Return Type

## Decision

Implement a new default-off rule for one narrow TypeChecker proof. Keep the retired `antidrift/no-explicit-return-type-private-helper` decision locked.

The old rule treated nearly every non-exported explicit return annotation as suspicious. Real Chaski code disproved that premise: private error mappers, `never` helpers, optional results, URL builders, predicates, hooks, builders, and gateway APIs can own legitimate contracts.

The new `antidrift/no-redundant-local-return-type` rule asks a different question: can TypeScript prove both that removing a nested implementation's annotation leaves the same object return shape and that a real enclosing return contract still owns every call result?

## First Real Drift

Murderbox `apps/client/src/components/chat/model-selector-menu-data.ts` supplied the first anchor. At committed source line 311, the nested `selectedFor` arrow returned `{ configs, selectedConfigId, selectedConfig }` and declared `SelectedVideoConfigData`. Each returned shorthand binding had the identical TypeChecker type as the corresponding required mutable property in the directly declared type literal. Every call feeds the object returned by `selectedVideoConfigDataFor(...): Record<VideoModelId, SelectedVideoConfigData>`, and that result in turn feeds `deriveModelSelectorMenuData(...): ModelSelectorMenuData` through `selectedVideoConfigByModel`. Removing only the nested annotation therefore preserves both inferred property types and an independently declared enclosing owner.

## Blocking Proof

The rule reports only when all of these conditions hold:

- the implementation is a nested function declaration or a direct `const` arrow/function initializer;
- the variable has no contextual type annotation, and the function is not async or a generator;
- the return annotation names a non-generic type alias declared directly as a non-empty object type literal;
- every declared member is a required mutable property, with no methods, call signatures, constructors, or index signatures;
- the function has exactly one return, as its final statement or expression body;
- the returned object contains only shorthand identifier properties and has exactly the declared property names;
- each shorthand binding's TypeChecker type is the same type object as its declared property type, excluding `any`, `unknown`, `never`, and callable values;
- the immediate enclosing function has an explicit return annotation;
- every reference outside the implementation is a direct call inside that enclosing function's own return expression, and the TypeChecker gives every call the same contextual type object as the nested annotation;
- the function is not overloaded, recursive, dependent on another local function, exposed through a direct or indirect public boundary, or itself a boundary.

The property identity and contextual-call identity proofs avoid bidirectional assignability. Assignability would accept narrower literals, optional/readonly differences, and structurally compatible but behaviorally different contracts. Property equality by itself is insufficient: without the enclosing contextual owner, removing an annotation can remove the only contract check rather than eliminate a duplicate.

## Deliberate Non-Coverage

The rule stays silent for top-level private helpers, exported functions, public object/class methods, callbacks, typed function variables, helpers inside inferred-return owners, calls assigned to unconstrained locals, overloads, recursion, async/generator functions, multiple or conditional returns, non-object returns, property remapping, spreads, computed keys, inline/interface/imported/derived return types, and optional or readonly contracts. Functions returned through `export const api = { build }`, export wrappers, or export specifiers remain public even when the function declaration itself lacks an `export` modifier.

These are false negatives by design. Widening the rule to them would reopen the retired private-helper policy without a proof that the annotation is redundant.

## Ecosystem Boundary

`@typescript-eslint/explicit-function-return-type` and `@typescript-eslint/explicit-module-boundary-types` require annotations on selected surfaces. They do not prove redundancy or preserve the distinction between public contracts and nested inference. No maintained equivalent owns this exact inverse, TypeChecker-backed proof.

## Promotion Gate

Keep the rule default-off. Promotion requires independent real drift, a clean inventory over repositories with nested builders and protocol/error helpers, and review of every finding against the retired rule's clean controls.
