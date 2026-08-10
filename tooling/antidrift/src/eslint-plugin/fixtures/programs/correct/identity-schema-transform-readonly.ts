import { z } from "zod";

export const MutableCopySchema = z
  .object({ a: z.string() })
  .readonly()
  .transform((record) => ({ a: record.a }));

const ReadonlyDefaultSchema = z
  .object({ a: z.string() })
  .readonly()
  .default({ a: "" });

export const DefaultMutableCopySchema = ReadonlyDefaultSchema.transform(
  (record) => ({ a: record.a }),
);

const ReadonlyCatchSchema = z
  .object({ a: z.string() })
  .readonly()
  .catch({ a: "" });

export const CatchMutableCopySchema = ReadonlyCatchSchema.transform(
  (record) => ({ a: record.a }),
);
