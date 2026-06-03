import { useEffect } from "react";

declare function loadUser(userId: string): Promise<void>;

export function UserPanel({ userId }: { userId: string }) {
  useEffect(() => {
    void loadUser(userId);
  });

  return null;
}
