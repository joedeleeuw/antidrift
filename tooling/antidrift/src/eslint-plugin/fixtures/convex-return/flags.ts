import { queryGeneric as query } from "convex/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  returns: v.array(v.object({ title: v.any() })),
  handler: () => [],
});
