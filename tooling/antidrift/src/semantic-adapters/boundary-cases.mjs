export const boundaryCases = {
  roots: [
    {
      kind: "filesystem",
      owner: "@types/node",
      platform: true,
      modules: ["fs", "fs/promises"],
      symbols: [
        "readFile",
        "readFileSync",
        "read",
        "readSync",
        "readv",
        "readvSync",
        "createReadStream",
        "readdir",
        "readdirSync",
        "FileHandle.readFile",
        "FileHandle.read",
        "FileHandle.readv",
        "FileHandle.readLines",
        "FileHandle.createReadStream",
      ],
      reason:
        "File contents and directory entries arrive from persisted state outside the program.",
    },
    {
      kind: "network",
      owner: "@types/node",
      platform: true,
      modules: ["net", "http", "https", "http2", "tls", "dgram"],
      symbols: [
        "connect",
        "createConnection",
        "get",
        "request",
        "createServer",
        "Socket.on",
        "Socket.once",
        "Socket.read",
        "IncomingMessage.on",
        "IncomingMessage.read",
        "Server.on",
        "ClientRequest.on",
        "TLSSocket.on",
      ],
      reason:
        "Network reads and receiving callbacks carry bytes or request metadata from a peer.",
    },
    {
      kind: "process-input",
      owner: "@types/node",
      platform: true,
      symbols: [
        "NodeJS.Process.env",
        "NodeJS.Process.argv",
        "NodeJS.Process.stdin",
        "NodeJS.ProcessEnv",
      ],
      reason:
        "Environment, command-line arguments and standard input are supplied by the host.",
    },
    {
      kind: "child-process",
      owner: "@types/node",
      platform: true,
      modules: ["child_process"],
      symbols: [
        "exec",
        "execSync",
        "execFile",
        "execFileSync",
        "spawn",
        "spawnSync",
        "fork",
        "ChildProcess.stdout",
        "ChildProcess.stderr",
        "ChildProcess.on",
      ],
      reason:
        "A child process supplies output and IPC messages independently of the caller's types.",
    },
    {
      kind: "stream",
      owner: "@types/node",
      platform: true,
      modules: ["stream"],
      symbols: [
        "Readable.read",
        "Readable.on",
        "Readable.once",
        "Stream.Readable.read",
        "Stream.Readable.on",
        "Stream.Readable.once",
      ],
      reason:
        "An incoming readable stream supplies chunks; constructed local receivers retain their argument provenance instead.",
    },
    {
      kind: "fetch",
      platform: true,
      libraries: ["lib.dom.d.ts", "lib.webworker.d.ts"],
      symbols: ["fetch", "WindowOrWorkerGlobalScope.fetch"],
      reason: "The response carrier comes from an outbound HTTP request.",
    },
    {
      kind: "node-fetch",
      owner: "@types/node",
      platform: true,
      symbols: ["fetch"],
      reason:
        "Node's global fetch declaration returns a remote response carrier.",
    },
    {
      kind: "node-http-body",
      owner: "undici-types",
      platform: true,
      symbols: [
        "BodyMixin.json",
        "BodyMixin.text",
        "BodyMixin.arrayBuffer",
        "BodyMixin.blob",
        "BodyMixin.formData",
        "BodyMixin.bytes",
      ],
      reason:
        "Node's global Request and Response declarations inherit these published Undici body-reader signatures.",
    },
    {
      kind: "http-body",
      platform: true,
      libraries: ["lib.dom.d.ts", "lib.webworker.d.ts"],
      symbols: [
        "Body.json",
        "Body.text",
        "Body.arrayBuffer",
        "Body.blob",
        "Body.formData",
        "Body.bytes",
        "Request.body",
        "Response.body",
      ],
      reason:
        "A received request or response exposes a remote body. Locally constructed bodies follow their constructor arguments.",
    },
    {
      kind: "message",
      platform: true,
      libraries: ["lib.dom.d.ts", "lib.webworker.d.ts"],
      symbols: ["MessageEvent.data"],
      reason:
        "WebSocket, EventSource, worker and postMessage delivery exposes a message payload. An explicitly typed payload keeps its upstream owner type.",
    },
    {
      kind: "storage",
      platform: true,
      libraries: ["lib.dom.d.ts", "lib.webworker.d.ts"],
      symbols: [
        "Storage",
        "Storage.getItem",
        "StorageEvent.newValue",
        "StorageEvent.oldValue",
      ],
      reason:
        "Browser storage supplies persisted strings that may need decoding after deserialization.",
    },
    {
      kind: "browser-stream",
      platform: true,
      libraries: ["lib.dom.d.ts", "lib.webworker.d.ts"],
      symbols: [
        "ReadableStreamDefaultReader.read",
        "ReadableStreamBYOBReader.read",
        "Blob.text",
        "Blob.arrayBuffer",
        "FileReader.result",
      ],
      reason:
        "Browser file and stream readers supply external bytes or text unless the receiver is constructed locally.",
    },
    {
      kind: "bun-fetch",
      owner: "bun-types",
      platform: true,
      files: ["globals.d.ts", "bun.d.ts"],
      symbols: ["fetch", "FetchSession.fetch"],
      reason: "Bun's runtime fetch declarations receive remote HTTP responses.",
    },
    {
      kind: "bun-body",
      owner: "bun-types",
      platform: true,
      files: ["globals.d.ts", "overrides.d.ts"],
      symbols: [
        "Blob.json",
        "Blob.text",
        "BunConsumerConvenienceMethods.json",
        "BunConsumerConvenienceMethods.text",
        "BunConsumerConvenienceMethods.bytes",
        "BunConsumerConvenienceMethods.arrayBuffer",
      ],
      reason:
        "Bun's published body and stream readers consume received bytes; local constructors retain argument provenance. Request/Response also inherit DOM or Undici body declarations.",
    },
    {
      kind: "bun-process",
      owner: "bun-types",
      platform: true,
      files: ["bun.d.ts", "globals.d.ts"],
      symbols: ["env", "argv", "ImportMeta.env"],
      reason: "Bun exposes host-supplied environment and process arguments.",
    },
    {
      kind: "bun-message",
      owner: "bun-types",
      platform: true,
      files: ["bun.d.ts"],
      symbols: ["BunMessageEvent.data"],
      reason:
        "Bun's message event carries incoming payloads; explicitly typed payloads keep their upstream types.",
    },
    {
      kind: "bun-serialized-input",
      owner: "bun-types",
      platform: true,
      files: ["bun.d.ts", "globals.d.ts"],
      symbols: ["YAML.parse", "JSONC.parse", "JSONL.parse"],
      argument: 0,
      requiresProvenance: true,
      reason:
        "Bun's runtime YAML, JSONC and JSONL parsers deserialize text that traces to I/O or an exported string entry parameter.",
    },
    {
      kind: "worker-fetch",
      owner: "@cloudflare/workers-types",
      platform: true,
      files: ["index.d.ts"],
      symbols: ["fetch", "ServiceWorkerGlobalScope.fetch", "Fetcher.fetch"],
      reason:
        "Worker fetch and service bindings receive HTTP response carriers.",
    },
    {
      kind: "worker-body",
      owner: "@cloudflare/workers-types",
      platform: true,
      files: ["index.d.ts"],
      symbols: [
        "Body.body",
        "Body.json",
        "Body.text",
        "Body.arrayBuffer",
        "Body.blob",
        "Body.formData",
        "Body.bytes",
      ],
      reason:
        "Worker Request and Response inherit incoming body readers from Body. The static Response.json constructor is not an input reader.",
    },
    {
      kind: "worker-message",
      owner: "@cloudflare/workers-types",
      platform: true,
      files: ["index.d.ts"],
      symbols: ["MessageEvent.data"],
      reason: "Worker message delivery carries a remote payload.",
    },
    {
      kind: "effect-http",
      owners: ["@effect/platform", "effect"],
      files: [
        "HttpIncomingMessage.d.ts",
        "HttpServerRequest.d.ts",
        "HttpClientResponse.d.ts",
        "HttpRouter.d.ts",
      ],
      symbols: [
        "HttpIncomingMessage.json",
        "HttpIncomingMessage.text",
        "HttpIncomingMessage.urlParamsBody",
        "HttpIncomingMessage.arrayBuffer",
        "HttpIncomingMessage.stream",
        "HttpIncomingMessage.headers",
        "HttpServerRequest.multipart",
        "HttpServerRequest.multipartStream",
        "HttpServerRequest.cookies",
        "HttpClientResponse.formData",
        "HttpClientResponse.cookies",
        "RouteContext.params",
        "params",
      ],
      reason:
        "Effect Platform raw HTTP request, response and router readers supply undecoded wire inputs; schemaBodyJson and schemaParams variants decode via Schema.",
    },
    {
      kind: "effect-filesystem",
      owners: ["@effect/platform", "effect"],
      files: ["FileSystem.d.ts"],
      symbols: [
        "FileSystem.readFile",
        "FileSystem.readFileString",
        "FileSystem.readDirectory",
        "FileSystem.stream",
      ],
      reason:
        "Effect Platform filesystem services read persisted bytes and text from outside the program.",
    },
    {
      kind: "queue-job-payload",
      owner: "bullmq",
      files: ["job.d.ts"],
      symbols: ["Job.data"],
      opaque: true,
      reason:
        "BullMQ job payloads arrive from an external queue store and are not validated by TypeScript's generic Job<T> parameter.",
    },
    {
      kind: "pubsub-message",
      owners: ["@redis/client", "redis", "ioredis"],
      files: ["pub-sub.d.ts", "index.d.ts", "Redis.d.ts"],
      symbols: [
        "PubSubListener",
        "RedisClient.subscribe",
        "RedisClient.pSubscribe",
        "RedisClient.sSubscribe",
        "Redis.on",
        "Redis.once",
      ],
      reason:
        "Redis pub/sub subscription listeners receive raw message strings or buffers from the broker.",
    },
    {
      kind: "ws-message",
      owners: ["@types/ws", "ws"],
      files: ["index.d.ts"],
      symbols: [
        "WebSocket.on",
        "WebSocket.once",
        "WebSocket.addEventListener",
        "WebSocket.onmessage",
        "WebSocket.MessageEvent.data",
      ],
      reason:
        "Node ws listeners and message events deliver raw frame payloads from a remote peer.",
    },
    {
      kind: "mcp-input",
      owner: "@modelcontextprotocol/sdk",
      files: ["mcp.d.ts", "protocol.d.ts"],
      symbols: ["BaseToolCallback", "Protocol.setRequestHandler"],
      reason:
        "MCP tool and protocol request handlers receive client-supplied JSON-RPC arguments.",
    },
    {
      kind: "serialized-input",
      platform: true,
      libraries: ["lib.es5.d.ts"],
      symbols: ["JSON.parse"],
      argument: 0,
      requiresProvenance: true,
      reason:
        "Deserialization opens an opaque payload when its string traces to I/O or an exported string entry parameter, and reports incomplete analysis when its string provenance is unresolved.",
    },
    {
      kind: "unknown-entry",
      parameter: "unknown",
      exported: true,
      reason:
        "An exported first-party entry point explicitly declares that its caller supplies an untrusted subject.",
    },
    {
      kind: "serialized-entry",
      parameter: "string",
      exported: true,
      activation: "serialized-input",
      reason:
        "An exported string parameter supplies provenance for deserialization; a string alone does not claim an unchecked object shape.",
    },
  ],
  frameworks: [
    {
      kind: "request-object",
      path: [],
      required: ["body", "query", "params", "headers"],
      payloads: ["body", "query", "params", "headers"],
      examples: ["Express", "Fastify"],
      reason:
        "A dependency-owned handler parameter exposes the incoming request fields.",
    },
    {
      kind: "request-context",
      path: ["req"],
      required: ["json", "query", "param", "header"],
      payloads: [
        "json",
        "text",
        "arrayBuffer",
        "blob",
        "formData",
        "parseBody",
        "query",
        "queries",
        "param",
        "header",
      ],
      examples: ["Hono"],
      reason:
        "The handler's request member exposes body readers, form parsing and URL/header input.",
    },
    {
      kind: "host-bindings",
      path: [],
      required: ["req", "env", "res"],
      payloads: ["env"],
      examples: ["Hono Context.env"],
      reason:
        "Host environment bindings on a framework context are supplied by the runtime host, like process.env.",
    },
    {
      kind: "web-request",
      path: [],
      required: ["json", "headers", "method", "url"],
      payloads: [
        "json",
        "text",
        "arrayBuffer",
        "blob",
        "formData",
        "headers",
        "url",
      ],
      examples: ["Next route handlers"],
      reason:
        "A request parameter carries HTTP metadata and body readers. Explicit Request parameters also use the platform Body declarations.",
    },
  ],
  decoders: [
    {
      kind: "assertion",
      predicate: "asserts",
      output: "predicate",
      examples: ["manual asserts", "Effect Schema assertions"],
      reason:
        "The checker must narrow the same subject after an assertion signature.",
    },
    {
      kind: "predicate",
      predicate: "is",
      output: "predicate",
      examples: ["manual type guards", "schema predicate functions"],
      reason:
        "Only the branch in which the checker narrows the same subject is decoded.",
    },
    {
      kind: "result",
      input: "any-or-unknown",
      output: "carrier",
      carriers: [
        {
          owner: "zod",
          discriminant: "success",
          success: true,
          payload: "data",
          examples: ["Zod safeParse", "Zod safeParseAsync"],
        },
        {
          owners: ["effect", "@effect/schema"],
          discriminant: "_tag",
          success: "Right",
          payload: "right",
          examples: ["Effect Schema decodeUnknownEither", "Either results"],
        },
      ],
      reason:
        "A validation carrier is the published success-or-failure contract of its owning package, recognised by the declaration's package and the carrier's discriminant and payload members. Passing, assigning or returning the intact carrier is safe; reading its payload is decoded only where the checker has narrowed the carrier to its success variant, and an assertion is not that narrowing. A decoded domain union is a value, not a carrier.",
    },
    {
      kind: "value",
      input: "any-or-unknown-or-deserialized-string",
      output: "typed",
      examples: [
        "Zod parse/parseAsync",
        "Effect Schema decodeUnknownSync/decodeUnknown/decodeUnknownEffect",
        "Yup validate/validateSync/cast",
      ],
      reason:
        "A declared any/unknown input and typed return, including an awaited return, establish the output contract, not a discarded input. A first-party string input that the body deserializes with a declared deserializer is the same subject once opened. Instantiating a generic carrier parameter as any does not turn it into a decoder.",
    },
  ],
  primitiveGuards: [
    {
      typeof: "string",
      flag: "String",
      reason: "A strict typeof check proves a string payload field.",
    },
    {
      typeof: "number",
      flag: "Number",
      reason: "A strict typeof check proves a number payload field.",
    },
    {
      typeof: "boolean",
      flag: "Boolean",
      reason: "A strict typeof check proves a boolean payload field.",
    },
    {
      typeof: "bigint",
      flag: "BigInt",
      reason: "A strict typeof check proves a bigint payload field.",
    },
  ],
  exclusions: [
    {
      kind: "generated-file",
      fact: "generatedFile",
      markers: [
        { prefix: "@generated" },
        { prefix: "Code generated", suffix: "DO NOT EDIT." },
        { prefix: "This file was generated by" },
        { prefix: "Generated by" },
      ],
      reason:
        "A file whose leading comment declares that it was generated is owned by its code generator.",
    },
    {
      kind: "unresolved-awaitable",
      fact: "unresolvedReturn",
      reason:
        "A recursive or invalid thenable whose awaited type the checker cannot resolve provides no typed decoder output. Declared input flow remains available; the model does not substitute a return contract.",
    },
    {
      kind: "decoded-procedure",
      fact: "upstreamContract",
      required: ["input", "ctx"],
      payloads: ["input"],
      examples: ["tRPC"],
      reason:
        "The procedure's declared input validator owns its input contract. Generic input and context plumbing do not establish outside provenance; nested raw requests must independently match an I/O declaration.",
    },
    {
      kind: "platform-projection",
      fact: "platformProjection",
      reason:
        "A non-predicate platform coercion or serializer is a projection, not contract validation. Its received I/O argument retains provenance for downstream deserialization while string formatting produces a known string.",
    },
    {
      kind: "unproved-first-party-decoder",
      fact: "unprovedDecoder",
      reason:
        "A first-party return annotation or cast cannot certify validation. Every normal return must be checker-narrowed from the subject, built from a recognised decoder or a guarded scalar projection of the subject, or be a null or undefined failure literal beside at least one proved return; a value that passed through an assertion is not narrowed; unresolved implementations retain input provenance.",
    },
    {
      kind: "assertion-chain",
      fact: "castChain",
      reason:
        "A double cast such as `as unknown as T` belongs to no-unsafe-cast-chain alone, whichever typed use receives it.",
    },
    {
      kind: "claimed-path",
      fact: "claimed",
      reason:
        "The first reportable claim on a path is the report. A later use whose demanded contract the earlier claim already covers, with no any or unknown leaf on the demanded path, repeats that claim instead of making a new one. A safe use such as a string kept as a string, a widening, a projection or an unknown sink claims nothing.",
    },
    {
      kind: "undemanded-field",
      fact: "undemanded",
      reason:
        "Provenance on an object field the receiving contract does not demand, or on a spread whose demanded fields later explicit properties all override, does not make the use unchecked.",
    },
    {
      kind: "intact-carrier",
      fact: "intactCarrier",
      reason:
        "A validation carrier passed, assigned or returned whole to a contract that accepts the carrier is consumed by its eliminator, not by the program's trust.",
    },
    {
      kind: "inferred-generic-contract",
      fact: "inferredFromArgument",
      reason:
        "A parameter whose type is an unconstrained type parameter instantiated only from the argument demands nothing; a constraint the callee declares, or a receiver's type argument, still demands that contract.",
    },
    {
      kind: "defaulted-generic",
      fact: "genericWithoutInput",
      reason:
        "A defaulted or uninstantiated type parameter is not outside input. Independent I/O provenance is required.",
    },
    {
      kind: "decoded-output",
      fact: "decoded",
      reason:
        "A decoder's output already has the owner's contract, including checked generic Result projections.",
    },
    {
      kind: "checker-narrowed",
      fact: "narrowed",
      reason:
        "A value already narrowed to the receiving contract, including a non-null object projected to an unknown-valued record, stays typed across aliases and callbacks where the checker preserves the narrowing.",
    },
    {
      kind: "dependency-plumbing",
      fact: "unresolved",
      reason:
        "Dependency any/unknown, metadata, state and callbacks are not roots without a declared received argument carrying I/O provenance.",
    },
    {
      kind: "local-production",
      fact: "local",
      reason:
        "Local constructors and serialization of local values do not create I/O provenance.",
    },
    {
      kind: "decoder-subject",
      fact: "decoderSubject",
      reason:
        "A first-party decoder owns its subject only when every returned payload is proved narrowed or decoded; an explicit annotation alone provides no exemption.",
    },
    {
      kind: "unknown-accepting-use",
      fact: "acceptsUnknown",
      reason:
        "A broad receiving contract, including an individual unknown rest element, does not impose a trusted payload shape.",
    },
    {
      kind: "unopened-string-entry",
      fact: "unopenedString",
      reason:
        "An exported string entry parameter or string formatting projection activates only when a declared deserializer opens it.",
    },
  ],
  collections: [
    {
      symbols: [
        "Array",
        "ReadonlyArray",
        "ConcatArray",
        "ArrayLike",
        "Iterable",
        "Iterator",
        "IterableIterator",
        "AsyncIterable",
        "AsyncIterator",
        "AsyncIterableIterator",
        "Generator",
        "AsyncGenerator",
        "Set",
        "ReadonlySet",
      ],
      elementIndex: 0,
      reason:
        "Sequential and set collections carry their element contract in the first type parameter.",
    },
    {
      symbols: ["Map", "ReadonlyMap"],
      elementIndex: 1,
      reason:
        "Key-value map collections carry their value contract in the second type parameter.",
    },
  ],
  nonForwardingOutputs: [
    {
      kind: "this-return",
      property: "isThisType",
      reason:
        "A method returning polymorphic this chains the receiver without projecting a value output.",
    },
    {
      kind: "numeric-return",
      numeric: true,
      reason:
        "A numeric return such as Array.push or String.indexOf reports a count or offset, not the input payload.",
    },
    {
      kind: "void-return",
      voidLike: true,
      reason: "A void return such as Array.forEach carries no output value.",
    },
  ],
};
