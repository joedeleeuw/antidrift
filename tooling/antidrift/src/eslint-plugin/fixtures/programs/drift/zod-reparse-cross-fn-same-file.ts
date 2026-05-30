import { z } from "zod";
const OrderSchema = z.object({ id: z.string(), total: z.number(), currency: z.string() });
declare function loadOrder(): unknown;
const order = OrderSchema.parse(loadOrder());   // validated once at module scope
export function persist() {
  return OrderSchema.parse(order);              // redundant: order already validated by OrderSchema
}
