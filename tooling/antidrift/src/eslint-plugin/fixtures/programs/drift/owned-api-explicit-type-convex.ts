import { useMutation, useQuery as useConvexQuery } from "convex/react";

import { api } from "../convex/_generated/api";

export function useMachinesRestated() {
  return useConvexQuery<typeof api.machines.list>(api.machines.list);
}

export function useRegisterRestated() {
  return useMutation<typeof api.machines.register>(api.machines.register);
}
