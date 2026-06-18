import { useState } from "react";

function FilterPanel() {
  const [query, setQuery] = useState("");
  return (nextQuery: string) => setQuery(nextQuery);
}

void FilterPanel;
