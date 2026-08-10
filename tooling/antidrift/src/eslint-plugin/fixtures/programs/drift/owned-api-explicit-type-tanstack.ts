import {
  queryOptions,
  useQuery as useTanstackQuery,
  useQueryClient,
} from "@tanstack/react-query";

declare function fetchMachines(): Promise<{ id: string; name: string }[]>;

const machinesQuery = queryOptions({
  queryKey: ["machines"] as const,
  queryFn: fetchMachines,
});

type HandwrittenMachine = { id: string; name: string };

export function useMachines() {
  return useTanstackQuery<HandwrittenMachine[]>(machinesQuery);
}

export function readCachedMachines() {
  const queryClient = useQueryClient();
  return queryClient.getQueryData<HandwrittenMachine[]>(machinesQuery.queryKey);
}
