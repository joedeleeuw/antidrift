import { randomUUID } from "node:crypto";

import type { Session } from "../shared/session";
import type { Todo, TodoPatch, TodoStatus } from "../shared/todo";

type PatchSink = (patch: TodoPatch) => void;

const todos = new Map<string, Todo>();
const sinks = new Set<PatchSink>();

function publish(patch: TodoPatch): void {
  for (const sink of sinks) {
    sink(patch);
  }
}

function findTodo(id: string): Todo {
  const todo = todos.get(id);
  if (todo === undefined) {
    throw new Error("todo not found", { cause: { id } });
  }
  return todo;
}

export function listTodos(listId: string): Promise<Todo[]> {
  return Promise.resolve(
    [...todos.values()].filter((todo) => todo.listId === listId)
  );
}

export function getTodo(id: string): Promise<Todo> {
  return new Promise((resolve) => {
    resolve(findTodo(id));
  });
}

export function insertTodo(
  draft: Omit<Todo, "id" | "createdAt" | "status">
): Promise<Todo> {
  const todo: Todo = {
    ...draft,
    id: randomUUID(),
    status: "open",
    createdAt: new Date(),
  };
  todos.set(todo.id, todo);
  publish({ kind: "added", todo });
  return Promise.resolve(todo);
}

export function setTodoStatus(id: string, status: TodoStatus): Promise<Todo> {
  return new Promise((resolve) => {
    const next = { ...findTodo(id), status };
    todos.set(id, next);
    publish({ kind: "changed", id, status });
    resolve(next);
  });
}

export function sinkCount(): number {
  return sinks.size;
}

export function watchTodos(signal: AbortSignal): ReadableStream<TodoPatch> {
  let cleanup = (): void => {};
  return new ReadableStream<TodoPatch>({
    start(controller) {
      if (signal.aborted) {
        controller.close();
        return;
      }
      const sink: PatchSink = (patch) => {
        controller.enqueue(patch);
      };
      const onAbort = (): void => {
        cleanup();
        controller.close();
      };
      cleanup = () => {
        sinks.delete(sink);
        signal.removeEventListener("abort", onAbort);
      };
      sinks.add(sink);
      signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
}

export function requireOwner(session: Session, todo: Todo): void {
  if (todo.ownerId !== session.userId) {
    throw new Error("forbidden", {
      cause: { userId: session.userId, todoId: todo.id, ownerId: todo.ownerId },
    });
  }
}
