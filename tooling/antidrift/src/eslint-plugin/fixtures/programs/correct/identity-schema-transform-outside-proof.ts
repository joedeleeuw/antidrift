import { z } from "zod";

const SingleFieldSchema = z.object({ a: z.string() });

export const SpreadSchema = SingleFieldSchema.transform((record) => ({
  ...record,
}));

export const ComputedKeySchema = SingleFieldSchema.transform((record) => ({
  ["a"]: record.a,
}));

export const GetterSchema = SingleFieldSchema.transform((record) => ({
  get a() {
    return record.a;
  },
}));

export const MethodSchema = SingleFieldSchema.transform((record) => ({
  a() {
    return record.a;
  },
}));

export const ContextCallbackSchema = SingleFieldSchema.transform(
  (record, _context) => ({ a: record.a }),
);

export const MultiStatementSchema = SingleFieldSchema.transform((record) => {
  void record;
  return { a: record.a };
});

export const GeneratorTransformSchema = SingleFieldSchema.transform(
  function* transform(record) {
    return { a: record.a };
  },
);

export const CustomObjectSchema = z
  .custom<{ a: string }>()
  .transform((record) => ({ a: record.a }));
