declare const __antidriftBrand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [__antidriftBrand]: {
    readonly value: T;
    readonly name: Name;
  };
};

export type Unbrand<T> = T extends {
  readonly [__antidriftBrand]: { readonly value: infer Value };
} ? Value : T;

export type BrandCheck<T> = (value: unknown) => value is T;

export type BrandSafeResult<T, Name extends string> =
  | { ok: true; value: Brand<T, Name> }
  | { ok: false; error: unknown };

export type BrandKit<T, Name extends string> = {
  readonly name: Name;
  make(value: unknown): Brand<T, Name>;
  safe(value: unknown): BrandSafeResult<T, Name>;
  is(value: unknown): value is Brand<T, Name>;
};

export function brand<const Name extends string, T>(
  name: Name,
  check: BrandCheck<T>,
): BrandKit<T, Name>;

export function brand<const Name extends string, T = unknown>(
  name: Name,
  check: (value: unknown) => boolean,
): BrandKit<T, Name>;
