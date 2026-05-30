# Bad Pattern Examples

These snippets are documentation only and are ignored by lint.

## Typed selector wrapper

```ts
function getPointFromBag(bag: Bag): Point {
  return bag.point;
}
```

Use `bag.point` directly or promote the contract to the owning boundary.

## Coupled state cells

```tsx
const [data, setData] = useState(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState(null);
```

Use one reducer/resource value.
