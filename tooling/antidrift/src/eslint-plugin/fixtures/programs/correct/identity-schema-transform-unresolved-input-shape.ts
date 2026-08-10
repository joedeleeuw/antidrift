import { z } from "zod";

declare const dynamicRecordSchema: z.ZodType<Record<string, string>>;

export const DynamicIdentitySchema = dynamicRecordSchema.transform(
  (_record) => ({}),
);
