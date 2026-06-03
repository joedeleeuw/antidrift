import { useState } from "react";

export function UsersPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  return { data, loading, error, setData, setLoading, setError };
}
