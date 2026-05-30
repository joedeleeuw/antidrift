import { useEffect, useReducer } from "react";

import { Button } from "@agent-guardrails/ui";

import { loadUser, type LoadUserResult } from "../../apiClient";

type UserPanelState =
  | { state: "idle" }
  | { state: "loading" }
  | LoadUserResult;

type UserPanelAction =
  | { type: "load" }
  | { type: "loaded"; result: LoadUserResult };

function userPanelReducer(_state: UserPanelState, action: UserPanelAction): UserPanelState {
  switch (action.type) {
    case "load":
      return { state: "loading" };
    case "loaded":
      return action.result;
  }
}

export function UserPanel() {
  const [state, dispatch] = useReducer(userPanelReducer, { state: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "load" });

    void loadUser(controller.signal).then((result) => {
      dispatch({ type: "loaded", result });
    });

    return () => controller.abort();
  }, []);

  if (state.state === "loading" || state.state === "idle") {
    return <section className="rounded-md border-border-subtle bg-surface-default p-4 text-fg-muted">Loading user...</section>;
  }

  if (state.state === "failed") {
    return <section className="rounded-md border-border-danger bg-surface-danger p-4 text-fg-danger">{state.message}</section>;
  }

  return (
    <section className="rounded-md border-border-subtle bg-surface-default p-4 text-fg-default">
      <h2>{state.user.displayName}</h2>
      <p>{state.user.email}</p>
      <Button>View profile</Button>
    </section>
  );
}
