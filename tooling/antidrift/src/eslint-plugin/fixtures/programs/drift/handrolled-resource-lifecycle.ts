import { useState } from "react";

declare function loadUsers(): Promise<string[]>;

function UsersPanel() {
  const [users, setUsers] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  return async function load() {
    setPending(true);
    setFailure(null);
    try {
      const result = await loadUsers();
      setUsers(result);
    } catch (err) {
      setFailure(err);
    } finally {
      setPending(false);
    }
  };
}

void UsersPanel;
