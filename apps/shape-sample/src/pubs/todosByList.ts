import { listTodos, watchTodos } from "../server/store";

import type { Session } from "../shared/session";
import type { TodoPatch } from "../shared/todo";

export async function* todosByList(
  listId: string,
  session: Session,
  signal: AbortSignal
): AsyncGenerator<TodoPatch> {
  const live = watchTodos(signal);
  const visible = new Set<string>();
  for (const todo of await listTodos(listId)) {
    if (todo.ownerId === session.userId) {
      visible.add(todo.id);
      yield { kind: "added", todo };
    }
  }
  for await (const patch of live) {
    switch (patch.kind) {
      case "added":
        if (
          patch.todo.listId === listId &&
          patch.todo.ownerId === session.userId
        ) {
          visible.add(patch.todo.id);
          yield patch;
        }
        break;
      case "changed":
        if (visible.has(patch.id)) {
          yield patch;
        }
        break;
      case "removed":
        if (visible.delete(patch.id)) {
          yield patch;
        }
        break;
    }
  }
}
