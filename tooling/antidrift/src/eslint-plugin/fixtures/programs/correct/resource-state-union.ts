import { useState } from "react";

type UsersResource =
  | { state: "loading" }
  | { state: "loaded"; rows: string[] }
  | { state: "failed"; message: string };

export function UsersPanel() {
  const [resource, setResource] = useState<UsersResource>({ state: "loading" });

  return { resource, setResource };
}
