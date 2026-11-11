import type { StreamConnection, StreamHandlers, StreamOpenRequest, StreamTransport } from "@qajitsu/steps";

/** Splits a server-sent events text into its events (REQ-EXEC-47/AC2); returns the rest that is not complete yet. */
export function parseEventStream(buffer: string): {
  readonly events: readonly { readonly event?: string; readonly id?: string; readonly data: string }[];
  readonly rest: string;
} {
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    let event: string | undefined;
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    return data.length === 0
      ? []
      : [
          {
            ...(event === undefined ? {} : { event }),
            ...(id === undefined ? {} : { id }),
            data: data.join("\n"),
          },
        ];
  });
  return { events, rest };
}

const websocket = (request: StreamOpenRequest, handlers: StreamHandlers, timeoutMs: number) =>
  new Promise<StreamConnection>((resolve, reject) => {
    const socket = new WebSocket(request.url, {
      headers: { ...request.headers },
      ...(request.protocols ? { protocols: [...request.protocols] } : {}),
    });
    socket.binaryType = "arraybuffer";
    let opened = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no answer within ${String(timeoutMs / 1000)} s`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send: (text) => {
          socket.send(text);
        },
        close: () => {
          socket.close(1000);
        },
      });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      handlers.message(
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
      );
    });
    // A refused handshake (e.g. HTTP 401) is reported with `error` alone by Node.js 22's client, with `error` and then
    // `close` by later ones: either way it is the answer, not a reason to wait for the open timeout.
    socket.addEventListener("error", () => {
      if (opened) return;
      clearTimeout(timer);
      reject(new Error("the server refused the connection before it opened"));
    });
    socket.addEventListener("close", (event: { readonly code: number; readonly reason: string }) => {
      clearTimeout(timer);
      // REQ-EXEC-47/AC5: a socket that never opened reports why; one that did reports how it ended.
      if (!opened)
        reject(
          new Error(
            `closed with ${String(event.code)}${event.reason ? ` ${event.reason}` : ""} before it opened`,
          ),
        );
      else handlers.close(event.code, event.reason);
    });
  });

const eventStream = async (
  request: StreamOpenRequest,
  handlers: StreamHandlers,
  timeoutMs: number,
): Promise<StreamConnection> => {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(request.url, {
      headers: { ...request.headers, accept: "text/event-stream" },
      redirect: "manual",
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("text/event-stream") || !res.body) {
    abort.abort();
    throw new Error(`HTTP ${String(res.status)}${type ? ` ${type}` : ""}, not an event stream`);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEventStream(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) handlers.message(e.data, e);
      }
      handlers.close(1000, "");
    } catch (error) {
      handlers.close(
        1006,
        abort.signal.aborted ? "" : error instanceof Error ? error.message : String(error),
      );
    }
  })();
  return {
    send: () => undefined,
    close: () => {
      abort.abort();
    },
  };
};

/**
 * Opens WebSockets (Node's built-in client, with the account's headers) and server-sent event streams (fetch) for the
 * runtime in the trusted parent (REQ-EXEC-47). An open that fails or does not answer in time rejects with the reason.
 *
 * @param options - How long opening may take (default 10 s).
 */
export function createStreamTransport(options: { readonly openTimeoutMs?: number } = {}): StreamTransport {
  const timeoutMs = options.openTimeoutMs ?? 10_000;
  return (request, handlers) =>
    request.kind === "websocket"
      ? websocket(request, handlers, timeoutMs)
      : eventStream(request, handlers, timeoutMs);
}
