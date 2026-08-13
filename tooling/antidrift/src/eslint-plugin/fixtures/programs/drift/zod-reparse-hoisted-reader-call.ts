import { z } from "zod";

const orderSchema = z.object({ id: z.string(), total: z.number() });

declare const raw: unknown;
const order = orderSchema.parse(raw);

// assertOrder() only reads the value, so provenance survives the call.
export function persist() {
  assertOrder();
  return orderSchema.parse(order);
}

function assertOrder() {
  if (order.id === "") {
    throw new Error("empty order id");
  }
}
