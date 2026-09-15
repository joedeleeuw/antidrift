import { queryGeneric as query } from "convex/server";
import { v } from "convex/values";

const message = v.object({ title: v.string() });

export const list = query({
  args: {},
  returns: v.array(message),
  handler: () => [],
});
