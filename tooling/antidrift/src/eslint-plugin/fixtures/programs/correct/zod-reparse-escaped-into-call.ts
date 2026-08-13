import { z } from "zod";

const cartSchema = z.object({ id: z.string(), items: z.array(z.string()) });

declare function enrich(cart: { id: string; items: string[] }): void;

// The value escapes into a call that may mutate it, so provenance is spent.
export function checkout(raw: unknown) {
  const cart = cartSchema.parse(raw);
  enrich(cart);
  return cartSchema.parse(cart);
}
