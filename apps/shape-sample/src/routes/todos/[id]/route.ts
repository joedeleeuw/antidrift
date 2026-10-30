import { getTodo, requireOwner } from "../../../server/store";

import type { Session } from "../../../shared/session";

export async function GET(
  _request: Request,
  session: Session,
  params: Record<string, string>
): Promise<Response> {
  const id = params["id"];
  if (id === undefined) {
    return new Response("missing id", { status: 400 });
  }
  const todo = await getTodo(id);
  requireOwner(session, todo);
  return Response.json(todo);
}
