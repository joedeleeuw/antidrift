declare function useState<T>(value: T): [T, (value: T) => void];
declare function fetchUser(id: string, signal: AbortSignal): Promise<string>;

function Profile() {
  const [user, setUser] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  return async function load(id: string) {
    const controller = new AbortController();
    setPending(true);
    setFailure(null);
    try {
      const data = await fetchUser(id, controller.signal);
      if (controller.signal.aborted) return;
      setUser(data);
    } catch (err) {
      setFailure(err);
    } finally {
      setPending(false);
    }
  };
}

void Profile;
