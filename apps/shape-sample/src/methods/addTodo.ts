import { insertTodo } from "../server/store";

import type { Session } from "../shared/session";
import type { Todo } from "../shared/todo";

export async function addTodo(
  input: {
    listId: string;
    title: string;
    tags?: string[];
    note?: string;
    priority?: number;
    dueAt?: Date;
  },
  session: Session
): Promise<Todo> {
  const todo = await insertTodo({
    listId: input.listId,
    ownerId: session.userId,
    title: input.title,
    priority: input.priority ?? 0,
    pinned: false,
    dueAt: input.dueAt ?? null,
    tags: input.tags ?? [],
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return todo;
}
