import type { Session } from "../shared/session";

export type MethodInvoker = (
  args: readonly unknown[],
  session: Session
) => Promise<unknown>;

export type PubInvoker = (
  args: readonly unknown[],
  session: Session,
  signal: AbortSignal
) => AsyncGenerator;

type RouteHandler = (
  request: Request,
  session: Session,
  params: Record<string, string>
) => Promise<Response>;

type RouteModule = Partial<
  Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", RouteHandler>
>;

export type RouteEntry = {
  pattern: string;
  load: () => Promise<RouteModule>;
};

export type DispatchTable = {
  methods: Record<string, MethodInvoker>;
  pubs: Record<string, PubInvoker>;
  routes: readonly RouteEntry[];
};

const encoder = new TextEncoder();

function errorResponse(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return Response.json({ message, cause }, { status });
}

function isWireArgs(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function decodeArgs(request: Request): Promise<readonly unknown[]> {
  const parsed: unknown = await request.json();
  if (!isWireArgs(parsed)) {
    throw new Error("wire args must be a JSON array", { cause: { parsed } });
  }
  return parsed;
}

function streamGenerator(
  generator: AsyncGenerator,
  controller: AbortController
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      const next = await generator.next();
      if (next.done) {
        sink.close();
        return;
      }
      sink.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel() {
      controller.abort();
      await generator.return(undefined);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

function matchRoute(
  pattern: string,
  pathname: string
): Record<string, string> | undefined {
  const expected = pattern.split("/").filter((segment) => segment.length > 0);
  const actual = pathname.split("/").filter((segment) => segment.length > 0);
  if (expected.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index];
    if (value === undefined) {
      return undefined;
    }
    if (segment.startsWith("[") && segment.endsWith("]")) {
      params[segment.slice(1, -1)] = decodeURIComponent(value);
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
}

function findRoute(
  table: DispatchTable,
  pathname: string
): { entry: RouteEntry; params: Record<string, string> } | undefined {
  for (const entry of table.routes) {
    const params = matchRoute(entry.pattern, pathname);
    if (params !== undefined) {
      return { entry, params };
    }
  }
  return undefined;
}

async function dispatchRoute(
  table: DispatchTable,
  request: Request,
  session: Session,
  pathname: string
): Promise<Response> {
  const route = findRoute(table, pathname);
  if (route === undefined) {
    return errorResponse(new Error("no route", { cause: { pathname } }), 404);
  }
  const routeModule = await route.entry.load();
  const verb = request.method.toUpperCase();
  const handler =
    verb === "GET" ||
    verb === "POST" ||
    verb === "PUT" ||
    verb === "PATCH" ||
    verb === "DELETE"
      ? routeModule[verb]
      : undefined;
  if (handler === undefined) {
    return errorResponse(
      new Error(`no ${verb} handler`, { cause: { pathname } }),
      405
    );
  }
  return handler(request, session, route.params);
}

export function createHandler(
  table: DispatchTable,
  resolveSession: (request: Request) => Session
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const session = resolveSession(request);
    try {
      const method = url.pathname.match(/^\/_method\/([^/]+)$/);
      if (method?.[1] !== undefined) {
        const invoke = table.methods[method[1]];
        if (invoke === undefined) {
          return errorResponse(new Error(`unknown method ${method[1]}`), 404);
        }
        return Response.json(await invoke(await decodeArgs(request), session));
      }
      const pub = url.pathname.match(/^\/_pub\/([^/]+)$/);
      if (pub?.[1] !== undefined) {
        const invoke = table.pubs[pub[1]];
        if (invoke === undefined) {
          return errorResponse(new Error(`unknown publication ${pub[1]}`), 404);
        }
        const controller = new AbortController();
        return streamGenerator(
          invoke(await decodeArgs(request), session, controller.signal),
          controller
        );
      }
      return await dispatchRoute(table, request, session, url.pathname);
    } catch (error) {
      return errorResponse(
        error,
        error instanceof Error && error.name === "DecodeError" ? 400 : 500
      );
    }
  };
}
