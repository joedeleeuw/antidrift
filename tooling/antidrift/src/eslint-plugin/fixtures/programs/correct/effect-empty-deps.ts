import { useEffect } from "react";

export function UserPanel() {
  useEffect(() => {
    document.title = "Users";
  }, []);

  return null;
}
