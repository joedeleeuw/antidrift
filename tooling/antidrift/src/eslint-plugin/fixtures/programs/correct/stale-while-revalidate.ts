declare function useState<T>(value: T): [T, (value: T) => void];
declare function fetchItems(query: string): Promise<string[]>;

function SearchResults() {
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  return async function refresh(query: string) {
    setLoading(true);
    try {
      const next = await fetchItems(query);
      setItems(next);
    } finally {
      setLoading(false);
    }
  };
}

void SearchResults;
