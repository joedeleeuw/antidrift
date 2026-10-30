import { getTodo, requireOwner, setTodoStatus } from "../server/store";
import { canCompleteTodo } from "../shared/todo";

import type { Session } from "../shared/session";
import type { Todo } from "../shared/todo";

export async function completeTodo(
  todoId: string,
  session: Session
): Promise<Todo> {
  const todo = await getTodo(todoId);
  requireOwner(session, todo);
  if (!canCompleteTodo(todo, session)) {
    throw new Error("todo cannot be completed", {
      cause: { todoId, status: todo.status },
    });
  }
  return setTodoStatus(todoId, "done");
}
