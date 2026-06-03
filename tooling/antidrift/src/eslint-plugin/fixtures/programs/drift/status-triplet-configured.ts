import { useState } from "react";

export function UsersPanel() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  return { rows, busy, failure, setRows, setBusy, setFailure };
}
