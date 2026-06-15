declare function useQuery<T>(
  key: string,
  fn: () => Promise<T>,
): { data: T | undefined; isLoading: boolean; error: Error | null };
declare function fetchUsers(): Promise<string[]>;

function UsersPanel() {
  const { data, isLoading, error } = useQuery("users", fetchUsers);
  return { data, isLoading, error };
}

void UsersPanel;
