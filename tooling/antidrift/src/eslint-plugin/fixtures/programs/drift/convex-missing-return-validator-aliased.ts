import { query as publicQuery } from "../convex/_generated/server";

export const list = publicQuery({
  args: {},
  handler: async () => [] as string[],
});
