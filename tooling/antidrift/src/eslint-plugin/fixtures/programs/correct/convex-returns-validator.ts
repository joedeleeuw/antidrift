import { v } from "convex/values";

import { internalAction, mutation, query } from "../convex/_generated/server";

export const get = query({
  args: { id: v.id("machines") },
  returns: v.union(v.object({ id: v.id("machines") }), v.null()),
  handler: async (_ctx, args) => ({ id: args.id }),
});

export const register = mutation({
  args: { name: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => args.name,
});

export const prune = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
