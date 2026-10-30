import { createTodoList } from "../src/client/todoList";
import { addTodo, completeTodo, todosByList } from "../src/generated/client";
import { table } from "../src/generated/server";
import { decodeAddTodoResult } from "../src/generated/wire";
import { callMethod, setTransport } from "../src/runtime/client";
import { expectObject, expectString } from "../src/runtime/decode";
import { createHandler } from "../src/runtime/server";

import type { Session } from "../src/shared/session";

const ada: Session = { userId: "user_ada", tenantId: "tenant_1" };
const bob: Session = { userId: "user_bob", tenantId: "tenant_1" };
let viewer = ada;
const handle = createHandler(table, () => viewer);
setTransport((request) => handle(request));

type Step = { title: string; run: () => Promise<void> };
const steps: Step[] = [];
function step(title: string, run: () => Promise<void>): void {
  steps.push({ title, run });
}
function check(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(detail);
  }
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}
function causeText(error: unknown): string {
  return JSON.stringify(error instanceof Error ? error.cause : error);
}

let createdId = "";

step(
  "addTodo round-trips through derived decoders, Date included",
  async () => {
    const todo = await addTodo({
      listId: "list_1",
      title: "ship the probe",
      tags: ["rust"],
      priority: 2,
    });
    check(
      todo.createdAt instanceof Date,
      "createdAt did not come back as a Date"
    );
    check(
      todo.priority === 2 && !todo.pinned && todo.dueAt === null,
      "number, boolean or null fields were lost on the wire"
    );
    check(todo.ownerId === ada.userId, "session was not injected server-side");
    check(
      todo.status === "open" && todo.tags.length === 1,
      "fields were lost on the wire"
    );
    check(!("note" in todo), "absent optional field was materialized");
    createdId = todo.id;
  }
);

step(
  "malformed wire input fails at the boundary and names the field",
  async () => {
    const error = await rejection(
      callMethod(
        "addTodo",
        [{ listId: "list_1", title: 42 }],
        decodeAddTodoResult
      )
    );
    check(
      error instanceof Error && error.message.includes("400"),
      `expected status 400: ${String(error)}`
    );
    check(
      causeText(error).includes("args[0].title"),
      `error did not name the field: ${causeText(error)}`
    );
  }
);

step(
  "completeTodo enforces ownership through the injected session",
  async () => {
    viewer = bob;
    const forbidden = await rejection(completeTodo(createdId));
    check(
      causeText(forbidden).includes("forbidden"),
      `bob completed ada's todo: ${causeText(forbidden)}`
    );
    viewer = ada;
    const done = await completeTodo(createdId);
    check(done.status === "done", "ada could not complete her own todo");
  }
);

step(
  "publication streams typed patches and stops when the client stops",
  async () => {
    const patches = todosByList("list_1");
    const first = await patches.next();
    check(
      !first.done &&
        first.value.kind === "added" &&
        first.value.todo.id === createdId,
      `initial snapshot patch missing: ${JSON.stringify(first)}`
    );
    const pending = patches.next();
    const dueAt = new Date("2026-11-01T09:00:00.000Z");
    const added = await addTodo({ listId: "list_1", title: "second", dueAt });
    const second = await pending;
    check(
      !second.done &&
        second.value.kind === "added" &&
        second.value.todo.id === added.id,
      `live patch missing: ${JSON.stringify(second)}`
    );
    check(
      !second.done &&
        second.value.kind === "added" &&
        second.value.todo.dueAt instanceof Date &&
        second.value.todo.dueAt.getTime() === dueAt.getTime(),
      "a Date argument did not survive the wire into the live patch"
    );
    await patches.return(undefined);
  }
);

step("publication withholds other owners' patches", async () => {
  const seed = await addTodo({ listId: "list_3", title: "ada seed" });
  const patches = todosByList("list_3");
  const first = await patches.next();
  check(
    !first.done &&
      first.value.kind === "added" &&
      first.value.todo.id === seed.id,
    `snapshot missing ada's todo: ${JSON.stringify(first)}`
  );
  const pending = patches.next();
  viewer = bob;
  const hidden = await addTodo({ listId: "list_3", title: "bob private" });
  await completeTodo(hidden.id);
  viewer = ada;
  const mine = await addTodo({ listId: "list_3", title: "ada second" });
  const next = await pending;
  check(
    !next.done && next.value.kind === "added" && next.value.todo.id === mine.id,
    `ada received another owner's patch: ${JSON.stringify(next)}`
  );
  await patches.return(undefined);
});

step(
  "client view model renders the optimistic patch, then the server's",
  async () => {
    const list = createTodoList("list_2", { userId: ada.userId });
    const renders: string[] = [];
    list.onChange((todos) => {
      renders.push(todos.map((todo) => todo.id).join(","));
    });
    const saved = await list.add("optimistic");
    check(
      renders[0] === "temp:optimistic",
      `first render was not optimistic: ${renders[0]}`
    );
    check(
      renders.at(-1) === saved.id,
      `final render was not reconciled: ${renders.at(-1)}`
    );
  }
);

step("route GET /todos/[id] serves JSON and refuses other owners", async () => {
  const ok = await handle(new Request(`http://app.local/todos/${createdId}`));
  check(ok.status === 200, `expected 200, got ${ok.status}`);
  const body: { id: string } = expectObject(
    await ok.json(),
    "body",
    (record) => ({
      id: expectString(record["id"], "body.id"),
    })
  );
  check(body.id === createdId, "route returned the wrong todo");
  viewer = bob;
  const refused = await handle(
    new Request(`http://app.local/todos/${createdId}`)
  );
  check(
    refused.status === 500,
    `expected a failure for bob, got ${refused.status}`
  );
  viewer = ada;
  const missing = await handle(new Request("http://app.local/nothing/here"));
  check(missing.status === 404, `expected 404, got ${missing.status}`);
});

async function runSteps(pending: readonly Step[]): Promise<number> {
  const [current, ...rest] = pending;
  if (current === undefined) {
    return 0;
  }
  const failed = await current.run().then(
    () => {
      process.stdout.write(`ok   ${current.title}\n`);
      return 0;
    },
    (error: unknown) => {
      process.stdout.write(
        `FAIL ${current.title}\n     ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
  );
  return failed + (await runSteps(rest));
}

const failures = await runSteps(steps);
process.stdout.write(
  `${steps.length - failures}/${steps.length} steps passed\n`
);
process.exitCode = failures === 0 ? 0 : 1;
