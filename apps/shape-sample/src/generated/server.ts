import type { Session } from "../shared/session";
import type { DispatchTable, MethodInvoker, PubInvoker, RouteEntry } from "../runtime/server";
import { decodeAddTodoArg0, decodeCompleteTodoArg0, decodeTodosByListArg0 } from "./wire";

const methods = {
  addTodo: async (args: readonly unknown[], session: Session): Promise<unknown> => {
    const { addTodo } = await import("../methods/addTodo");
    return addTodo(decodeAddTodoArg0(args[0], "args[0]"), session);
  },
  completeTodo: async (args: readonly unknown[], session: Session): Promise<unknown> => {
    const { completeTodo } = await import("../methods/completeTodo");
    return completeTodo(decodeCompleteTodoArg0(args[0], "args[0]"), session);
  },
} satisfies Record<string, MethodInvoker>;

const pubs = {
  todosByList: async function* (args: readonly unknown[], session: Session, signal: AbortSignal): AsyncGenerator {
    const { todosByList } = await import("../pubs/todosByList");
    yield* todosByList(decodeTodosByListArg0(args[0], "args[0]"), session, signal);
  },
} satisfies Record<string, PubInvoker>;

const routes: readonly RouteEntry[] = [
  { pattern: "/todos/[id]", load: () => import("../routes/todos/[id]/route") },
];

export const table: DispatchTable = { methods, pubs, routes };
