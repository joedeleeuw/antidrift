import { expectArray, expectBoolean, expectDate, expectLiteral, expectNull, expectNumber, expectObject, expectString, firstOf } from "../runtime/decode";
import type { Decoder, YieldOf } from "../runtime/decode";
import type { addTodo } from "../methods/addTodo";
import type { completeTodo } from "../methods/completeTodo";
import type { todosByList } from "../pubs/todosByList";

export type AddTodoArg0 = Parameters<typeof addTodo>[0];
export const decodeAddTodoArg0: Decoder<AddTodoArg0> = (raw, path) =>
  expectObject(raw, path, (record0) => ({ listId: expectString(record0["listId"], `${path}.listId`), title: expectString(record0["title"], `${path}.title`), ...(record0["tags"] === undefined ? {} : { tags: expectArray(record0["tags"], `${path}.tags`, (item1, itemPath1) => expectString(item1, itemPath1)) }), ...(record0["note"] === undefined ? {} : { note: expectString(record0["note"], `${path}.note`) }), ...(record0["priority"] === undefined ? {} : { priority: expectNumber(record0["priority"], `${path}.priority`) }), ...(record0["dueAt"] === undefined ? {} : { dueAt: expectDate(record0["dueAt"], `${path}.dueAt`) }) }));

export type AddTodoResult = Awaited<ReturnType<typeof addTodo>>;
export const decodeAddTodoResult: Decoder<AddTodoResult> = (raw, path) =>
  expectObject(raw, path, (record0) => ({ id: expectString(record0["id"], `${path}.id`), listId: expectString(record0["listId"], `${path}.listId`), ownerId: expectString(record0["ownerId"], `${path}.ownerId`), title: expectString(record0["title"], `${path}.title`), status: firstOf(record0["status"], `${path}.status`, [(raw1, path1) => expectLiteral(raw1, path1, "done"), (raw1, path1) => expectLiteral(raw1, path1, "open")]), createdAt: expectDate(record0["createdAt"], `${path}.createdAt`), dueAt: firstOf(record0["dueAt"], `${path}.dueAt`, [(raw1, path1) => expectNull(raw1, path1), (raw1, path1) => expectDate(raw1, path1)]), priority: expectNumber(record0["priority"], `${path}.priority`), pinned: expectBoolean(record0["pinned"], `${path}.pinned`), tags: expectArray(record0["tags"], `${path}.tags`, (item1, itemPath1) => expectString(item1, itemPath1)), ...(record0["note"] === undefined ? {} : { note: expectString(record0["note"], `${path}.note`) }) }));

export type CompleteTodoArg0 = Parameters<typeof completeTodo>[0];
export const decodeCompleteTodoArg0: Decoder<CompleteTodoArg0> = (raw, path) =>
  expectString(raw, path);

export type CompleteTodoResult = Awaited<ReturnType<typeof completeTodo>>;
export const decodeCompleteTodoResult: Decoder<CompleteTodoResult> = (raw, path) =>
  expectObject(raw, path, (record0) => ({ id: expectString(record0["id"], `${path}.id`), listId: expectString(record0["listId"], `${path}.listId`), ownerId: expectString(record0["ownerId"], `${path}.ownerId`), title: expectString(record0["title"], `${path}.title`), status: firstOf(record0["status"], `${path}.status`, [(raw1, path1) => expectLiteral(raw1, path1, "done"), (raw1, path1) => expectLiteral(raw1, path1, "open")]), createdAt: expectDate(record0["createdAt"], `${path}.createdAt`), dueAt: firstOf(record0["dueAt"], `${path}.dueAt`, [(raw1, path1) => expectNull(raw1, path1), (raw1, path1) => expectDate(raw1, path1)]), priority: expectNumber(record0["priority"], `${path}.priority`), pinned: expectBoolean(record0["pinned"], `${path}.pinned`), tags: expectArray(record0["tags"], `${path}.tags`, (item1, itemPath1) => expectString(item1, itemPath1)), ...(record0["note"] === undefined ? {} : { note: expectString(record0["note"], `${path}.note`) }) }));

export type TodosByListArg0 = Parameters<typeof todosByList>[0];
export const decodeTodosByListArg0: Decoder<TodosByListArg0> = (raw, path) =>
  expectString(raw, path);

export type TodosByListYield = YieldOf<ReturnType<typeof todosByList>>;
export const decodeTodosByListYield: Decoder<TodosByListYield> = (raw, path) =>
  firstOf(raw, path, [(raw0, path0) => expectObject(raw0, path0, (record1) => ({ kind: expectLiteral(record1["kind"], `${path0}.kind`, "added"), todo: expectObject(record1["todo"], `${path0}.todo`, (record2) => ({ id: expectString(record2["id"], `${path0}.todo.id`), listId: expectString(record2["listId"], `${path0}.todo.listId`), ownerId: expectString(record2["ownerId"], `${path0}.todo.ownerId`), title: expectString(record2["title"], `${path0}.todo.title`), status: firstOf(record2["status"], `${path0}.todo.status`, [(raw3, path3) => expectLiteral(raw3, path3, "done"), (raw3, path3) => expectLiteral(raw3, path3, "open")]), createdAt: expectDate(record2["createdAt"], `${path0}.todo.createdAt`), dueAt: firstOf(record2["dueAt"], `${path0}.todo.dueAt`, [(raw3, path3) => expectNull(raw3, path3), (raw3, path3) => expectDate(raw3, path3)]), priority: expectNumber(record2["priority"], `${path0}.todo.priority`), pinned: expectBoolean(record2["pinned"], `${path0}.todo.pinned`), tags: expectArray(record2["tags"], `${path0}.todo.tags`, (item3, itemPath3) => expectString(item3, itemPath3)), ...(record2["note"] === undefined ? {} : { note: expectString(record2["note"], `${path0}.todo.note`) }) })) })), (raw0, path0) => expectObject(raw0, path0, (record1) => ({ kind: expectLiteral(record1["kind"], `${path0}.kind`, "changed"), id: expectString(record1["id"], `${path0}.id`), status: firstOf(record1["status"], `${path0}.status`, [(raw2, path2) => expectLiteral(raw2, path2, "done"), (raw2, path2) => expectLiteral(raw2, path2, "open")]) })), (raw0, path0) => expectObject(raw0, path0, (record1) => ({ kind: expectLiteral(record1["kind"], `${path0}.kind`, "removed"), id: expectString(record1["id"], `${path0}.id`) }))]);
