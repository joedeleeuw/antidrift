import { listTodos, watchTodos } from "../server/store";

import type { Session } from "../shared/session";
import type { TodoPatch } from "../shared/todo";

export async function* todosByList(
  listId: string,
  session: Session,
  signal: AbortSignal
): AsyncGenerator<TodoPatch> {
  for (const todo of await listTodos(listId)) {
    if (todo.ownerId === session.userId) {
      yield { kind: "added", todo };
    }
  }
  for await (const patch of watchTodos(signal)) {
    if (patch.kind !== "added" || patch.todo.listId === listId) {
      yield patch;
    }
  }
}
