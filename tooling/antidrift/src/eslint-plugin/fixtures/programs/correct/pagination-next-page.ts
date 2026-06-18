import { useState } from "react";

declare function fetchPage(cursor: number): Promise<{ items: string[]; next: number }>;

function FeedList() {
  const [items, setItems] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  return async function loadNext() {
    setPending(true);
    setFailure(null);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next);
    } catch (err) {
      setFailure(err);
    } finally {
      setPending(false);
    }
  };
}

void FeedList;
