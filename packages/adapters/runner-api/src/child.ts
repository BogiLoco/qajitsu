// Sandboxed child of the API runner. It holds nothing worth stealing: no secrets, no network access,
// no file writes, read access only to the spec folder and this file. The spec's API calls, steps and
// verify() calls are forwarded to the parent, which performs HTTP, records evidence and computes every
// assertion from the responses it recorded and the approved plan (invariants 1, 2 and 4). Whatever the
// spec does to this process, the parent only accepts these operations and validates each one.
// This file has no imports so the sandbox needs no read access to installed packages.

/**
 * Cuts the child off the network before any spec code runs. Node's permission model denies network only from
 * Node 25 (`--allow-net`); on Node 22 and 24 it does not, so every way to open a connection or resolve a name is
 * replaced here by a function that throws, as a non-configurable property the spec cannot redefine, and the ESM views
 * of the built-in modules are synced so `import { connect } from "node:net"` gets the replacement too. The child
 * needs no network: every call goes through the parent over IPC (ADR-0004).
 */
function lockNetwork(): void {
  const deny = (): never => {
    throw new Error("network access is denied in the QAJitsu sandbox");
  };
  const builtin = (name: string): Record<string, unknown> | undefined => {
    try {
      return (
        process as unknown as { getBuiltinModule: (n: string) => Record<string, unknown> }
      ).getBuiltinModule(name);
    } catch {
      return undefined;
    }
  };
  const seal = (target: unknown, keys: readonly string[]): void => {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) return;
    for (const key of keys) {
      try {
        Object.defineProperty(target, key, {
          value: deny,
          writable: false,
          configurable: false,
          enumerable: true,
        });
      } catch {
        // Already non-configurable (e.g. denied by the permission model on newer Node): leave it.
      }
    }
  };
  const proto = (mod: Record<string, unknown> | undefined, cls: string): unknown =>
    (mod?.[cls] as { prototype?: unknown } | undefined)?.prototype;
  const net = builtin("node:net");
  seal(net, ["connect", "createConnection", "createServer"]);
  seal(proto(net, "Socket"), ["connect"]);
  seal(proto(net, "Server"), ["listen"]);
  seal(builtin("node:tls"), ["connect", "createServer"]);
  for (const name of ["node:http", "node:https"]) {
    seal(builtin(name), ["request", "get", "createServer"]);
    seal(proto(builtin(name), "Agent"), ["createConnection"]);
  }
  seal(builtin("node:http2"), ["connect", "createServer", "createSecureServer"]);
  const dgram = builtin("node:dgram");
  seal(dgram, ["createSocket"]);
  seal(proto(dgram, "Socket"), ["bind", "send", "connect"]);
  const resolvers = [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ];
  const dns = builtin("node:dns");
  seal(dns, resolvers);
  seal(proto(dns, "Resolver"), resolvers);
  const promises = dns?.["promises"] as Record<string, unknown> | undefined;
  seal(promises, resolvers);
  seal(proto(promises, "Resolver"), resolvers);
  seal(builtin("node:dns/promises"), resolvers);
  seal(globalThis, ["fetch", "WebSocket", "EventSource"]);
  try {
    (builtin("node:module") as { syncBuiltinESMExports?: () => void } | undefined)?.syncBuiltinESMExports?.();
  } catch {
    // Older Node: ESM views were never created yet, so they will be built from the sealed exports.
  }
}

lockNetwork();

interface StartMessage {
  readonly type: "start";
  readonly specFile: string;
  readonly caseId: string;
  /** Expectations of this case only, keyed `<case>.<step>.<field>`; returned by plan.expect for readability. */
  readonly expectations: Readonly<Record<string, unknown>>;
  /** Records created for this attempt by name (REQ-EXEC-53/AC1). */
  readonly testData: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface ReplyMessage {
  readonly type: "reply";
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

const rpc = (op: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    process.send?.({ type: "op", id: seq, ...op });
  });

const at = (value: unknown, path: string | undefined): unknown => {
  if (path === undefined || path === "") return value;
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function start(m: StartMessage): Promise<void> {
  const client = (alias: string | undefined): Record<string, unknown> => {
    const stream = async (
      kind: string,
      path: unknown,
      protocols: unknown,
      graphql?: unknown,
    ): Promise<unknown> => {
      const handle = await rpc({
        op: "streamOpen",
        alias,
        kind,
        path,
        ...(protocols === undefined ? {} : { protocols }),
        ...(graphql === undefined ? {} : { graphql }),
      });
      const op = (name: string, data?: unknown) =>
        rpc({ op: "streamOp", handle, name, ...(data === undefined ? {} : { data }) });
      return {
        send: (data: unknown) => op("send", typeof data === "string" ? data : JSON.stringify(data)),
        messages: () => op("messages"),
        close: () => op("close"),
      };
    };
    const send = async (method: string, path: string, body: unknown, options: unknown): Promise<unknown> => {
      // Only the request options go to the parent; method options such as a SOAP action travel in the body.
      const o = (options ?? {}) as { headers?: unknown; query?: unknown };
      const callOptions = {
        ...(o.headers === undefined ? {} : { headers: o.headers }),
        ...(o.query === undefined ? {} : { query: o.query }),
      };
      const r = (await rpc({ op: "call", alias, method, path, body, options: callOptions })) as {
        status: number;
        headers: Record<string, string>;
        text: string;
      };
      let parsed: unknown;
      try {
        parsed = r.text === "" ? undefined : (JSON.parse(r.text) as unknown);
      } catch {
        parsed = undefined;
      }
      return {
        status: r.status,
        headers: r.headers,
        text: r.text,
        json: (p?: string) => at(parsed, p),
        // REQ-EXEC-50/AC3: XPath is evaluated by the parent; the child has no XML parser.
        xml: (xpath: unknown) => rpc({ op: "xpath", text: r.text, xpath }),
      };
    };
    return {
      get: (path: string, o?: unknown) => send("GET", path, undefined, o),
      post: (path: string, b?: unknown, o?: unknown) => send("POST", path, b, o),
      put: (path: string, b?: unknown, o?: unknown) => send("PUT", path, b, o),
      patch: (path: string, b?: unknown, o?: unknown) => send("PATCH", path, b, o),
      delete: (path: string, o?: unknown) => send("DELETE", path, undefined, o),
      // REQ-EXEC-48/AC2: plain data; the parent checks the query and marks the call as GraphQL.
      graphql: (query: unknown, variables?: unknown, o?: { path?: unknown }) =>
        send(
          "POST",
          typeof o?.path === "string" ? o.path : "/graphql",
          { __qjBody: "graphql", query, ...(variables === undefined ? {} : { variables }) },
          o,
        ),
      // REQ-EXEC-50/AC1: plain data; the parent builds the envelope and marks the call as SOAP.
      soap: (path: string, body: unknown, o?: { action?: unknown; version?: unknown }) =>
        send(
          "POST",
          path,
          {
            __qjBody: "soap",
            body,
            ...(o?.action === undefined ? {} : { action: o.action }),
            ...(o?.version === undefined ? {} : { version: o.version }),
          },
          o,
        ),
      as: (a: string) => client(a),
      // REQ-EXEC-47: the parent opens the stream with the account's authentication and records every frame.
      websocket: (path: unknown, o?: { protocols?: unknown }) => stream("websocket", path, o?.protocols),
      events: (path: unknown) => stream("sse", path, undefined),
      // REQ-EXEC-48/AC2: the parent speaks graphql-transport-ws and keeps every payload.
      subscribe: (query: unknown, variables?: unknown, o?: { path?: unknown }) =>
        stream("websocket", typeof o?.path === "string" ? o.path : "/graphql", ["graphql-transport-ws"], {
          query,
          ...(variables === undefined ? {} : { variables }),
        }),
      // REQ-EXEC-45/AC1: body descriptors are plain data; the parent resolves files from the plan and checks them.
      multipart: (parts: { fields?: unknown; files?: unknown } = {}) => ({
        __qjBody: "multipart",
        fields: parts.fields,
        files: parts.files,
      }),
      form: (fields: unknown) => ({ __qjBody: "form", fields }),
      // Values are passed as they are: the parent refuses anything that is not a string.
      binary: (file: unknown) => ({ __qjBody: "binary", file }),
      text: (text: unknown, type?: unknown) => ({
        __qjBody: "text",
        text,
        ...(type === undefined ? {} : { type }),
      }),
    };
  };
  const context = {
    caseId: m.caseId,
    plan: {
      expect: (path: string): unknown => {
        if (!Object.hasOwn(m.expectations, path))
          throw new Error(`plan.expect('${path}'): not an expectation of ${m.caseId}`);
        return m.expectations[path];
      },
    },
    api: client(undefined),
    ui: {
      goto: (path: string) => rpc({ op: "ui", operation: { op: "goto", path } }),
      click: (selector: string) => rpc({ op: "ui", operation: { op: "click", selector } }),
      check: (selector: string) => rpc({ op: "ui", operation: { op: "check", selector } }),
      uncheck: (selector: string) => rpc({ op: "ui", operation: { op: "uncheck", selector } }),
      fill: (selector: string, value: unknown) =>
        rpc({ op: "ui", operation: { op: "fill", selector, value: String(value) } }),
      // The spec names an account and a field; the parent alone knows the value (REQ-EXEC-67/AC3).
      fillCode: (selector: string) => rpc({ op: "ui", operation: { op: "fillCode", selector } }),
      session: (name: unknown) => rpc({ op: "ui", operation: { op: "session", name } }),
      // Gestures (REQ-EXEC-41): the parent's schema checks every field.
      tap: (selector: string) =>
        rpc({ op: "ui", operation: { op: "gesture", gesture: { kind: "tap", selector } } }),
      doubleTap: (selector: string) =>
        rpc({ op: "ui", operation: { op: "gesture", gesture: { kind: "doubleTap", selector } } }),
      longPress: (selector: string, seconds: unknown = 1) =>
        rpc({ op: "ui", operation: { op: "gesture", gesture: { kind: "longPress", selector, seconds } } }),
      swipe: (target: string, direction: unknown, opts: { distance?: unknown; speed?: unknown } = {}) =>
        rpc({
          op: "ui",
          operation: {
            op: "gesture",
            gesture: {
              kind: "swipe",
              ...(target === "screen" ? {} : { selector: target }),
              direction,
              distance: opts.distance ?? 0.6,
              speed: opts.speed ?? "normal",
            },
          },
        }),
      pinch: (target: string, direction: unknown, scale: unknown = 0.6) =>
        rpc({
          op: "ui",
          operation: {
            op: "gesture",
            gesture: {
              kind: "pinch",
              ...(target === "screen" ? {} : { selector: target }),
              direction,
              scale,
            },
          },
        }),
      pullToRefresh: () =>
        rpc({ op: "ui", operation: { op: "gesture", gesture: { kind: "pullToRefresh" } } }),
      fillSecret: (selector: string, alias: unknown, field: unknown) =>
        rpc({ op: "ui", operation: { op: "fillSecret", selector, alias, field } }),
      select: (selector: string, value: unknown) =>
        rpc({ op: "ui", operation: { op: "select", selector, value: String(value) } }),
      press: (selector: string, value: unknown) =>
        rpc({ op: "ui", operation: { op: "press", selector, value: String(value) } }),
      waitFor: (selector: string, state = "visible") =>
        rpc({ op: "ui", operation: { op: "waitFor", selector, state } }),
      back: () => rpc({ op: "ui", operation: { op: "back" } }),
      as: (alias: string) => rpc({ op: "ui", operation: { op: "as", alias } }),
      hover: (selector: string) => rpc({ op: "ui", operation: { op: "hover", selector } }),
      dblclick: (selector: string) => rpc({ op: "ui", operation: { op: "dblclick", selector } }),
      rightClick: (selector: string) => rpc({ op: "ui", operation: { op: "rightclick", selector } }),
      dragTo: (selector: string, target: string) =>
        rpc({ op: "ui", operation: { op: "dragTo", selector, target } }),
      dragBy: (selector: string, dx: unknown, dy: unknown) =>
        rpc({ op: "ui", operation: { op: "dragBy", selector, dx: Number(dx), dy: Number(dy) } }),
      keys: (value: unknown) => rpc({ op: "ui", operation: { op: "keys", value: String(value) } }),
      scrollTo: (selector: string) => rpc({ op: "ui", operation: { op: "scrollTo", selector } }),
      scrollBy: (dx: unknown, dy: unknown) =>
        rpc({ op: "ui", operation: { op: "scrollBy", dx: Number(dx), dy: Number(dy) } }),
      scrollUntil: (selector: string) => rpc({ op: "ui", operation: { op: "scrollUntil", selector } }),
      upload: (selector: string, ...files: unknown[]) =>
        rpc({ op: "ui", operation: { op: "upload", selector, files: files.map(String) } }),
      download: (selector: string) => rpc({ op: "ui", operation: { op: "download", selector } }),
      switchToNewPage: () => rpc({ op: "ui", operation: { op: "switchPage", to: "new" } }),
      switchToOpener: () => rpc({ op: "ui", operation: { op: "switchPage", to: "opener" } }),
      closePage: () => rpc({ op: "ui", operation: { op: "closePage" } }),
      advanceTime: (seconds: unknown) =>
        rpc({ op: "ui", operation: { op: "advanceTime", seconds: Number(seconds) } }),
      // The parent's schema refuses anything but a boolean.
      setOffline: (offline: unknown) => rpc({ op: "ui", operation: { op: "setOffline", offline } }),
    },
    step: async (stepId: string, fn: () => unknown): Promise<void> => {
      await rpc({ op: "beginStep", stepId });
      try {
        // REQ-EXEC-46: the parent says whether a step with a planned wait runs another round (after its checks).
        do await fn();
        while ((await rpc({ op: "pollRound", stepId })) === true);
      } catch (e) {
        await rpc({ op: "endStep", stepId, error: message(e) });
        throw e;
      }
      await rpc({ op: "endStep", stepId });
    },
    verify: (stepId: string, field: string): void => {
      void rpc({ op: "verify", stepId, field }).catch(() => undefined);
    },
    data: {
      get: (name: string) => {
        if (!Object.hasOwn(m.testData, name))
          throw new Error(`data.get('${name.slice(0, 40)}'): no test data of ${m.caseId} has this name`);
        return m.testData[name];
      },
    },
    inbox: {
      address: (kind = "email") => rpc({ op: "inboxAddress", kind }),
      wait: async (stepId: string) => (await rpc({ op: "inboxWait", stepId })) ?? undefined,
    },
  };
  let error: string | undefined;
  try {
    const mod = (await import(new URL(`file://${m.specFile}`).href)) as { caseId?: unknown; run?: unknown };
    if (mod.caseId !== m.caseId)
      throw new Error(`spec exports caseId ${JSON.stringify(mod.caseId)}, expected ${m.caseId}`);
    if (typeof mod.run !== "function") throw new Error("spec must export async function run(context)");
    await (mod.run as (c: unknown) => Promise<void>)(context);
  } catch (e) {
    error = message(e);
  }
  process.send?.({ type: "done", ...(error === undefined ? {} : { error }) }, () => {
    process.exit(0);
  });
}

process.on("message", (m: StartMessage | ReplyMessage) => {
  if (m.type === "start") {
    void start(m);
  } else {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error ?? "operation refused"));
  }
});
