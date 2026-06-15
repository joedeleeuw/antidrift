declare function useState<T>(value: T): [T, (value: T) => void];
declare function useRef<T>(value: T): { current: T };
declare function fetchUser(id: string, signal: AbortSignal): Promise<string>;

function Profile() {
  const controllerRef = useRef(new AbortController());
  const [user, setUser] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  return async function load(id: string) {
    setPending(true);
    setFailure(null);
    try {
      const data = await fetchUser(id, controllerRef.current.signal);
      if (controllerRef.current.signal.aborted) return;
      setUser(data);
    } catch (err) {
      setFailure(err);
    } finally {
      setPending(false);
    }
  };
}

void Profile;
