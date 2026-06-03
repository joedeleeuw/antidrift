import { z } from "zod";

const RowSchema = z.object({ id: z.string(), total: z.number() });
type Row = z.infer<typeof RowSchema>;

async function getRows(): Promise<Row[]> {
  const raw: unknown[] = [];
  return raw.map((row) => RowSchema.parse(row));
}

export async function handler() {
  const rows = await getRows();
  return z.array(RowSchema).parse(rows);
}
