import { addTodo, todosByList } from "../generated/client";
import { applyPatch } from "../shared/todo";

import type { Todo, TodoPatch } from "../shared/todo";

type ChangeListener = (todos: readonly Todo[]) => void;

function createTodoState() {
  let todos: Todo[] = [];
  const listeners = new Set<ChangeListener>();
  return {
    todos: (): readonly Todo[] => todos,
    onChange: (listener: ChangeListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply: (...patches: TodoPatch[]): void => {
      todos = patches.reduce<Todo[]>(applyPatch, todos);
      for (const listener of listeners) {
        listener(todos);
      }
    },
  };
}

function optimisticTodo(listId: string, ownerId: string, title: string): Todo {
  return {
    id: `temp:${title}`,
    listId,
    ownerId,
    title,
    status: "open",
    createdAt: new Date(),
    dueAt: null,
    priority: 0,
    pinned: false,
    tags: [],
  };
}

export function createTodoList(listId: string, viewer: { userId: string }) {
  const state = createTodoState();
  return {
    todos: state.todos,
    onChange: state.onChange,
    async add(title: string): Promise<Todo> {
      const draft = optimisticTodo(listId, viewer.userId, title);
      state.apply({ kind: "added", todo: draft });
      try {
        const saved = await addTodo({ listId, title });
        state.apply(
          { kind: "removed", id: draft.id },
          { kind: "added", todo: saved }
        );
        return saved;
      } catch (error) {
        state.apply({ kind: "removed", id: draft.id });
        throw error;
      }
    },
    async follow(signal: AbortSignal): Promise<void> {
      for await (const patch of todosByList(listId)) {
        state.apply(patch);
        if (signal.aborted) {
          return;
        }
      }
    },
  };
}
