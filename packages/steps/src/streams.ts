import type { EvidenceItem } from "./runtime.js";
import type { Masker } from "./masking.js";

/** A WebSocket or a server-sent events stream (REQ-EXEC-47). */
export type StreamKind = "websocket" | "sse";

/** What the trusted parent opens for a step. */
export interface StreamOpenRequest {
  readonly kind: StreamKind;
  /** `ws:` / `wss:` for a WebSocket, `http:` / `https:` for server-sent events. */
  readonly url: string;
  /** The account's authentication and the step's headers. */
  readonly headers: Readonly<Record<string, string>>;
  readonly protocols?: readonly string[] | undefined;
}

/** What the transport reports while a stream is open. */
export interface StreamHandlers {
  /** A text frame, or an event with its `event` name and `id`. */
  readonly message: (text: string, event?: { readonly event?: string; readonly id?: string }) => void;
  /** The stream ended: the WebSocket close code and reason; an event stream that ends is `1000`. */
  readonly close: (code: number, reason: string) => void;
}

/** An open stream as the transport gives it back. */
export interface StreamConnection {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

/**
 * Opens WebSockets and event streams for the runtime (REQ-EXEC-47); rejects when the connection cannot be opened.
 * The runner gives one; without it a spec that opens a stream errors.
 */
export type StreamTransport = (
  request: StreamOpenRequest,
  handlers: StreamHandlers,
) => Promise<StreamConnection>;

/** A stream as a spec sees it (REQ-EXEC-47/AC1+AC2). */
export interface ApiStream {
  /** Sends a text frame; any other value is sent as JSON. Event streams cannot send. */
  readonly send: (data: unknown) => Promise<void>;
  /** The messages received so far: JSON parsed when it is JSON; an event is `{ event, id, data }`. */
  readonly messages: () => Promise<readonly unknown[]>;
  readonly close: () => Promise<void>;
}

/** One frame of a stream's evidence. */
interface Frame {
  readonly dir: "sent" | "received";
  readonly atMs: number;
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
}

/** A stream of one step, as the runtime records it. */
export interface StreamRecord {
  readonly stepId: string;
  readonly kind: StreamKind;
  /** Values as received, for checks; the evidence holds them masked. */
  readonly messages: unknown[];
  closed?: { readonly code: number; readonly reason: string };
}

interface Entry extends StreamRecord {
  readonly url: string;
  /** A GraphQL subscription over this WebSocket (REQ-EXEC-48/AC2): its query and masked variables. */
  readonly graphql?: { readonly query: string; readonly variables?: unknown };
  readonly openedAt: number;
  readonly frames: Frame[];
  readonly listeners: (() => void)[];
  connection?: StreamConnection;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/**
 * The streams of one attempt (REQ-EXEC-47): opened by the trusted parent with the account's authentication, only to
 * hosts of the environment allowlist (AC4), every frame kept as masked evidence (AC4), and an open that fails is the
 * step's error with its reason (AC5).
 *
 * @param options - Transport, allowlist, masking and clock of the attempt.
 */
export function createStreams(options: {
  readonly transport?: StreamTransport | undefined;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly masker: Masker;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}) {
  const entries: Entry[] = [];

  const notify = (entry: Entry): void => {
    for (const resolve of entry.listeners.splice(0)) resolve();
  };

  const open = async (
    stepId: string,
    kind: StreamKind,
    path: string,
    headers: Readonly<Record<string, string>>,
    protocols?: readonly string[],
    graphql?: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> },
  ): Promise<ApiStream> => {
    if (!options.transport)
      throw new Error(`api.${kind === "sse" ? "events" : "websocket"}: this runner has no streams`);
    if (typeof path !== "string") throw new Error("a stream's path must be a string");
    const url = new URL(path, options.baseUrl);
    // The allowlist names HTTP origins; a WebSocket to the same host is ws: or wss:.
    const http = new URL(url);
    if (http.protocol === "ws:") http.protocol = "http:";
    if (http.protocol === "wss:") http.protocol = "https:";
    if (!options.allowedOrigins.includes(http.origin))
      throw new Error(`URL ${http.origin} is not in the environment allowlist`);
    const target = new URL(http);
    if (kind === "websocket") target.protocol = http.protocol === "https:" ? "wss:" : "ws:";
    const entry: Entry = {
      stepId,
      kind,
      url: options.masker.maskText(target.toString()),
      openedAt: options.now(),
      frames: [],
      messages: [],
      listeners: [],
      ...(graphql
        ? {
            graphql: {
              query: graphql.query,
              ...(graphql.variables === undefined
                ? {}
                : { variables: options.masker.maskJson(graphql.variables) }),
            },
          }
        : {}),
    };
    entries.push(entry);
    const sendFrame = (text: string): void => {
      entry.frames.push({
        dir: "sent",
        atMs: options.now() - entry.openedAt,
        data: options.masker.maskText(text),
      });
      entry.connection?.send(text);
    };
    /**
     * REQ-EXEC-48/AC2: the graphql-transport-ws protocol. The answer to `connection_init` starts the subscription;
     * every `next` payload is a message, an `error` is `{ errors }`, and `complete` ends the stream.
     */
    const graphqlFrame = (text: string): void => {
      const frame = parse(text) as { type?: unknown; payload?: unknown } | null;
      const type = typeof frame === "object" && frame !== null ? frame.type : undefined;
      if (type === "connection_ack" && graphql)
        sendFrame(JSON.stringify({ id: "1", type: "subscribe", payload: graphql }));
      else if (type === "ping") sendFrame(JSON.stringify({ type: "pong" }));
      else if (type === "next") entry.messages.push(frame?.payload);
      else if (type === "error") entry.messages.push({ errors: frame?.payload });
      else if (type === "complete") {
        entry.closed ??= { code: 1000, reason: "complete" };
        entry.connection?.close();
      }
    };
    try {
      entry.connection = await options.transport(
        { kind, url: target.toString(), headers, ...(protocols ? { protocols } : {}) },
        {
          message: (text, event) => {
            entry.frames.push({
              dir: "received",
              atMs: options.now() - entry.openedAt,
              data: options.masker.maskText(text),
              ...(event?.event === undefined ? {} : { event: event.event }),
              ...(event?.id === undefined ? {} : { id: event.id }),
            });
            if (graphql) graphqlFrame(text);
            else
              entry.messages.push(
                kind === "sse"
                  ? { event: event?.event ?? "message", id: event?.id ?? null, data: parse(text) }
                  : parse(text),
              );
            notify(entry);
          },
          close: (code, reason) => {
            entry.closed ??= { code, reason: options.masker.maskText(reason) };
            notify(entry);
          },
        },
      );
    } catch (error) {
      // REQ-EXEC-47/AC5: a stream that cannot be opened is not a result of the application's messages.
      const reason = options.masker.maskText(error instanceof Error ? error.message : String(error));
      entry.closed = { code: 1006, reason };
      // The cause is left out on purpose: it holds the reason unmasked (invariant 8).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `the ${kind === "sse" ? "event stream" : "WebSocket"} ${entry.url} could not be opened: ${reason}`,
      );
    }
    const connection = entry.connection;
    if (graphql) sendFrame(JSON.stringify({ type: "connection_init" }));
    return {
      send: (data) => {
        if (kind === "sse") return Promise.reject(new Error("an event stream cannot send"));
        if (entry.closed)
          return Promise.reject(new Error(`the WebSocket is closed (${String(entry.closed.code)})`));
        if (graphql) return Promise.reject(new Error("a GraphQL subscription sends nothing after its query"));
        sendFrame(typeof data === "string" ? data : JSON.stringify(data));
        return Promise.resolve();
      },
      messages: () => Promise.resolve([...entry.messages]),
      close: () => {
        if (!entry.closed) {
          entry.closed = { code: 1000, reason: "closed by the test" };
          connection.close();
        }
        return Promise.resolve();
      },
    };
  };

  /**
   * Waits until `done` holds, the stream ends or `timeoutMs` passes; true when `done` holds.
   */
  const waitFor = async (record: StreamRecord, done: () => boolean, timeoutMs: number): Promise<boolean> => {
    const entry = record as Entry;
    const deadline = options.now() + timeoutMs;
    while (!done() && entry.closed === undefined && options.now() < deadline) {
      const changed = new Promise<void>((resolve) => entry.listeners.push(resolve));
      await Promise.race([changed, options.sleep(Math.min(100, deadline - options.now()))]);
    }
    return done();
  };

  return {
    open,
    waitFor,
    /** The last stream the step opened. */
    last: (stepId: string): StreamRecord | undefined => entries.filter((e) => e.stepId === stepId).at(-1),
    /** Closes every open stream; its frames are evidence (REQ-EXEC-47/AC4). */
    finish: (): EvidenceItem[] => {
      const perStep = new Map<string, number>();
      return entries.map((e) => {
        if (!e.closed && e.connection) {
          e.closed = { code: 1000, reason: "closed at the end of the case" };
          e.connection.close();
        }
        const n = (perStep.get(e.stepId) ?? 0) + 1;
        perStep.set(e.stepId, n);
        return {
          stepId: e.stepId,
          kind: "log",
          name: `${e.stepId}-${e.kind === "sse" ? "events" : "websocket"}-${String(n).padStart(2, "0")}.json`,
          // A subscription is marked like a GraphQL call, so the verifier checks its query and payloads (REQ-EXEC-48).
          content: `${JSON.stringify(
            {
              kind: e.kind,
              url: e.url,
              ...(e.graphql ? { graphql: true, request: { body: e.graphql } } : {}),
              frames: e.frames,
              closed: e.closed,
            },
            null,
            2,
          )}\n`,
        };
      });
    },
  };
}
