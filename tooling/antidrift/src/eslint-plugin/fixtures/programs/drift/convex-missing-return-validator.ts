import { v } from "convex/values";

import { internalMutation, query } from "../convex/_generated/server";

export const get = query({
  args: { id: v.id("machines") },
  handler: async (_ctx, args) => ({ id: args.id }),
});

export const register = internalMutation({
  args: { name: v.string() },
  handler: async (_ctx, args) => args.name,
});
