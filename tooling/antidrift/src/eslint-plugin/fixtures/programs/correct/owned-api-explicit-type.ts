import { useMutation, useQuery } from "convex/react";
import { useQueryClient, useQuery as useTanstackQuery } from "@tanstack/react-query";

import { api } from "../convex/_generated/api";

export function useMachines() {
  return useQuery(api.machines.list);
}

export function useRegisterMachine() {
  return useMutation(api.machines.register);
}

export function readCachedAdHocKey() {
  const queryClient = useQueryClient();
  return queryClient.getQueryData<{ id: string; name: string }[]>(["machines"]);
}

export function useInlineOptions() {
  return useTanstackQuery<{ id: string; name: string }[]>({
    queryKey: ["machines-inline"] as const,
    queryFn: async () => [{ id: "m1", name: "needle" }],
  });
}

declare function useLocalQuery<T>(reference: unknown): T;

export function useLocalShim() {
  return useLocalQuery<{ id: string; name: string }[]>(api.machines.list);
}
