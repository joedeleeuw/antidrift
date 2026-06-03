declare function useState<T>(value: T): [T, (value: T) => void];

function FilterPanel() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (nextQuery: string) => {
    setQuery(nextQuery);
    setPage(1);
    setSelectedId(null);
  };
}

void FilterPanel;
