import { callMethod, subscribePub } from "../runtime/client";
import {
  decodeAddTodoResult,
  decodeCompleteTodoResult,
  decodeTodosByListYield,
} from "./wire";
import type {
  AddTodoArg0,
  AddTodoResult,
  CompleteTodoArg0,
  CompleteTodoResult,
  TodosByListArg0,
  TodosByListYield,
} from "./wire";

export function addTodo(input: AddTodoArg0): Promise<AddTodoResult> {
  return callMethod("addTodo", [input], decodeAddTodoResult);
}

export function completeTodo(
  todoId: CompleteTodoArg0
): Promise<CompleteTodoResult> {
  return callMethod("completeTodo", [todoId], decodeCompleteTodoResult);
}

export function todosByList(
  listId: TodosByListArg0
): AsyncGenerator<TodosByListYield> {
  return subscribePub("todosByList", [listId], decodeTodosByListYield);
}
