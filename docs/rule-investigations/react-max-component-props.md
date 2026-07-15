# `antidrift/react-max-component-props`

## Definition

Limit the number of locally-owned props accepted by a JSX-returning React component.

This rule is about component API surface, not JSX formatting. It counts the props a component accepts through its first props parameter or `FC<Props>` annotation. It does not count how many attributes a caller puts on one line.

The rule requires TypeScript parser services. It counts locally-declared prop symbols and ignores inherited React/DOM library props so wrappers such as `ComponentProps<"button"> & { tone, size }` do not explode into every HTML attribute.

## Should Flag

```tsx
interface PanelProps {
  title: string;
  subtitle: string;
  status: string;
  count: number;
}

export function Panel(props: PanelProps) {
  return <section>{props.title}</section>;
}
```

Why: the component owns a broad public prop bag. Past a threshold, prop combinations become a local responsibility boundary that should usually be split, grouped into a cohesive owned object, or moved behind a resource/container boundary.

```tsx
type PanelProps = {
  title: string;
  subtitle: string;
  status: string;
  count: number;
};

export const Panel: React.FC<PanelProps> = (props) => {
  return <section>{props.title}</section>;
};
```

Why: contextual `React.FC<Props>` props are still the component's accepted API.

## Should Not Flag

```ts
interface LoaderInput {
  title: string;
  subtitle: string;
  status: string;
  count: number;
}

export function load(input: LoaderInput) {
  return input.title;
}
```

Why: the rule is scoped to JSX-returning React components.

```tsx
import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  tone?: "primary" | "secondary";
  size?: "sm" | "lg";
};

export function Button(props: ButtonProps) {
  return <button {...props} />;
}
```

Why: inherited React/DOM props are not locally-owned component API surface.

```tsx
type BaseProps = {
  one: string;
  two: string;
  three: string;
  four: string;
};

const Base = (_props: BaseProps) => null;

export function Wrapper(props: BaseProps) {
  return <Base {...props} />;
}
```

Why: pass-through wrappers can preserve another component's API without becoming the owner of every prop.

## Ecosystem

- `react/jsx-max-props-per-line` from `eslint-plugin-react` and `@stylistic/jsx-max-props-per-line` limit JSX attributes per line. They are formatting/call-site rules, not accepted component API rules.
- `@eslint-react/no-unused-props` covers defined-but-unused props. That is useful adjacent coverage, but it does not enforce an upper bound on a component's accepted prop contract.
- ESLint core `max-params` and Sonar rule `typescript:S107` limit function parameter count. They do not count members of a single React props object.
- `vue/max-props` in `eslint-plugin-vue` is exact coverage for Vue component prop count. Oxlint also exposes `vue/max-props`. The React equivalent was not found in maintained React ESLint, Sonar, Oxlint, or Biome coverage during the July 2026 search.

Primary references checked:

- https://github.com/jsx-eslint/eslint-plugin-react/blob/master/docs/rules/jsx-max-props-per-line.md
- https://eslint.style/rules/jsx-max-props-per-line
- https://eslint-react.xyz/docs/rules/no-unused-props
- https://eslint.org/docs/latest/rules/max-params
- https://eslint.vuejs.org/rules/max-props
- https://www.oxcjs.com/guide/usage/linter/rules/vue/max-props
- https://oxc.rs/docs/guide/usage/linter/rules.html

## Promotion State

Status: `ready`, `stable: false`.

The rule is enabled in `createConfig()` with `{ max: 12 }` because consumers should get the same React component API budget without running a separate scanner.

Real drift:

- `/Users/sushi/code/chaski/src/frontend/monolithui/src/components/FlightTrackerMap/MobileFlightTrackerMap.tsx` line 415 reports 31 locally-owned accepted props. The component combines mobile-specific controls with the extended flight-tracker map API.

Stable promotion still needs broader real-corpus inventory for the chosen threshold, especially around design-system wrappers, generated components, form/schema components, and components that deliberately mirror another component's prop API.
