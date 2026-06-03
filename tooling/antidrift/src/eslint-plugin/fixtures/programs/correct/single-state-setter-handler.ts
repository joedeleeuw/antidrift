declare function useState<T>(value: T): [T, (value: T) => void];

function FilterPanel() {
  const [query, setQuery] = useState("");
  return (nextQuery: string) => setQuery(nextQuery);
}

void FilterPanel;
