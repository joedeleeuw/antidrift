import type { Decoder } from "./decode";

export type Transport = (request: Request) => Promise<Response>;

const origin = "http://app.local";
const METHOD_TIMEOUT_MS = 30_000;
let transport: Transport = fetch;

export function setTransport(next: Transport): void {
  transport = next;
}

function wireRequest(
  kind: "method" | "pub",
  name: string,
  args: readonly unknown[],
  signal: AbortSignal
): Request {
  return new Request(`${origin}/_${kind}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
    signal,
  });
}

async function failure(name: string, response: Response): Promise<Error> {
  const body: unknown = await response.json();
  return new Error(`${name} failed with status ${response.status}`, {
    cause: body,
  });
}

export async function callMethod<T>(
  name: string,
  args: readonly unknown[],
  decodeResult: Decoder<T>
): Promise<T> {
  const response = await transport(
    wireRequest("method", name, args, AbortSignal.timeout(METHOD_TIMEOUT_MS))
  );
  if (!response.ok) {
    throw await failure(name, response);
  }
  return decodeResult(await response.json(), `${name}.result`);
}

export async function* subscribePub<T>(
  name: string,
  args: readonly unknown[],
  decodeYield: Decoder<T>
): AsyncGenerator<T> {
  const subscription = new AbortController();
  const response = await transport(
    wireRequest("pub", name, args, subscription.signal)
  );
  if (!response.ok || response.body === null) {
    throw await failure(name, response);
  }
  let buffered = "";
  try {
    for await (const chunk of response.body.pipeThrough(
      new TextDecoderStream()
    )) {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          yield decodeYield(JSON.parse(line), `${name}.yield`);
        }
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    subscription.abort();
  }
}
