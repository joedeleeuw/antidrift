import type { Session } from "./session";

export type TodoStatus = "open" | "done";

export type Todo = {
  id: string;
  listId: string;
  ownerId: string;
  title: string;
  status: TodoStatus;
  createdAt: Date;
  dueAt: Date | null;
  priority: number;
  pinned: boolean;
  tags: string[];
  note?: string;
};

export type TodoPatch =
  | { kind: "added"; todo: Todo }
  | { kind: "changed"; id: string; status: TodoStatus }
  | { kind: "removed"; id: string };

export function canCompleteTodo(todo: Todo, session: Session): boolean {
  return todo.ownerId === session.userId && todo.status === "open";
}

export function applyPatch(todos: readonly Todo[], patch: TodoPatch): Todo[] {
  switch (patch.kind) {
    case "added":
      return todos.some((todo) => todo.id === patch.todo.id)
        ? todos.map((todo) => (todo.id === patch.todo.id ? patch.todo : todo))
        : [...todos, patch.todo];
    case "changed":
      return todos.map((todo) =>
        todo.id === patch.id ? { ...todo, status: patch.status } : todo
      );
    case "removed":
      return todos.filter((todo) => todo.id !== patch.id);
  }
}
