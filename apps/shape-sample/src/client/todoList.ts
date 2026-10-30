import { addTodo, todosByList } from "../generated/client";
import { applyPatch } from "../shared/todo";

import type { Todo } from "../shared/todo";

type ChangeListener = (todos: readonly Todo[]) => void;

export function createTodoList(listId: string, viewer: { userId: string }) {
  let todos: Todo[] = [];
  const listeners = new Set<ChangeListener>();

  function replace(next: Todo[]): void {
    todos = next;
    for (const listener of listeners) {
      listener(todos);
    }
  }

  return {
    todos: (): readonly Todo[] => todos,
    onChange(listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async add(title: string): Promise<Todo> {
      const tempId = `temp:${title}`;
      replace(
        applyPatch(todos, {
          kind: "added",
          todo: {
            id: tempId,
            listId,
            ownerId: viewer.userId,
            title,
            status: "open",
            createdAt: new Date(),
            dueAt: null,
            priority: 0,
            pinned: false,
            tags: [],
          },
        })
      );
      try {
        const saved = await addTodo({ listId, title });
        replace(
          applyPatch(applyPatch(todos, { kind: "removed", id: tempId }), {
            kind: "added",
            todo: saved,
          })
        );
        return saved;
      } catch (error) {
        replace(applyPatch(todos, { kind: "removed", id: tempId }));
        throw error;
      }
    },
    async follow(signal: AbortSignal): Promise<void> {
      for await (const patch of todosByList(listId)) {
        replace(applyPatch(todos, patch));
        if (signal.aborted) {
          return;
        }
      }
    },
  };
}
