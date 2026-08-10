import { query } from "../convex/_generated/server";

const sharedConfig = {
  args: {},
};

export const list = query({
  ...sharedConfig,
  handler: async () => [] as string[],
});

const RETURNS_KEY = "returns";

export const get = query({
  args: {},
  [RETURNS_KEY]: null,
  handler: async () => null,
});
