import { z } from "zod";

const orderSchema = z.object({ id: z.string(), total: z.number() });
const contract = { createOrder: { body: orderSchema } };

export function submit(raw: unknown) {
  const order = contract.createOrder.body.parse(raw);
  const schema = contract.createOrder.body;
  // redundant: the alias expands to the same canonical path
  return schema.parse(order);
}
