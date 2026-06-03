# no-nullable-positional-tuple

## Scope

`antidrift/no-nullable-positional-tuple` flags tuple type syntax with two or more nullable or optional slots.

This is not a generic tuple ban. The smell is a positional state model where slot meaning is implicit and partial states multiply, for example `[Date | null, Date | null]`.

## Construction Pattern

Use a named object when the fields have names:

```ts
type DateRange = {
  start: Date | null;
  end: Date | null;
};
```

Use an explicit state union when partial states matter:

```ts
type DateRange =
  | { state: "empty" }
  | { state: "partial"; start: Date | null; end: Date | null }
  | { state: "complete"; start: Date; end: Date };
```

Import the owner type when a library already owns the tuple shape.

## Case Matrix

| Case | Should report | Reason |
|---|---:|---|
| `type CustomRange = [Date \| null, Date \| null]` | yes | Two nullable positional slots hide `start`/`end` meaning. |
| `type CustomRange = readonly [Date \| null, Date \| null]` | yes | Readonly does not remove the positional partial-state smell. |
| `type CustomRange = [start: Date \| null, end: Date \| null]` | yes | Labels help readers, but the type is still a nullable positional state model. |
| `type MaybeDate = Date \| null; type CustomRange = [MaybeDate, MaybeDate]` | yes, when type-aware | Alias chains should not dodge the rule when parser services are available. |
| `function select(range: [Date \| null, Date \| null]) {}` | yes | Inline tuple contracts are the same smell. |
| `type Point = [number, number]` | no | Non-null numeric coordinate pairs are ordinary tuple use. |
| `type HookResult = [value: Date \| null, setValue: (value: Date \| null) => void]` | no | Only one slot is nullable; common hook tuple shape stays out of scope. |
| `type Range = PickerRangeValue<Date>` | no | Importing the owner type is the desired path. |
| `type Dates = Array<Date \| null>` | no | Arrays are collections, not fixed positional fields. |
| `type MaybeRange = [Date, Date] \| null` | no | The whole value is nullable; the tuple slots are not partial fields. |

## Real Corpus Evidence

Chaski drift:

- `src/frontend/portal/modules/service-stop/route-assignments/types.ts` line 6: `CustomRange = [Date | null, Date | null]`.

Chaski clean control:

- `src/frontend/crow-v2/hooks/useCountingTasks.ts`: `convertUnitsToCases(): [number, number]`.

Broad Chaski frontend inventory reported exactly one finding across 1,533 files: the `CustomRange` type above.

## Boundaries

The rule reports local tuple syntax, not imported owner aliases. It intentionally requires at least two nullable or optional tuple slots so common hook returns with one nullable value slot do not become noise.

Type alias and generic-chain nullability require TypeScript parser services. Without parser services, the rule still catches direct syntax such as `Date | null`.
