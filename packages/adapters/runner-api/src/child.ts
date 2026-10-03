// Sandboxed child of the API runner. It holds nothing worth stealing: no secrets, no network access,
// no file writes, read access only to the spec folder and this file. The spec's API calls, steps and
// verify() calls are forwarded to the parent, which performs HTTP, records evidence and computes every
// assertion from the responses it recorded and the approved plan (invariants 1, 2 and 4). Whatever the
// spec does to this process, the parent only accepts these operations and validates each one.
// This file has no imports so the sandbox needs no read access to installed packages.

interface StartMessage {
  readonly type: "start";
  readonly specFile: string;
  readonly caseId: string;
  /** Expectations of this case only, keyed `<case>.<step>.<field>`; returned by plan.expect for readability. */
  readonly expectations: Readonly<Record<string, unknown>>;
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
    const send = async (method: string, path: string, body: unknown, options: unknown): Promise<unknown> => {
      const r = (await rpc({ op: "call", alias, method, path, body, options: options ?? {} })) as {
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
      return { status: r.status, headers: r.headers, text: r.text, json: (p?: string) => at(parsed, p) };
    };
    return {
      get: (path: string, o?: unknown) => send("GET", path, undefined, o),
      post: (path: string, b?: unknown, o?: unknown) => send("POST", path, b, o),
      put: (path: string, b?: unknown, o?: unknown) => send("PUT", path, b, o),
      patch: (path: string, b?: unknown, o?: unknown) => send("PATCH", path, b, o),
      delete: (path: string, o?: unknown) => send("DELETE", path, undefined, o),
      as: (a: string) => client(a),
    };
  };
  const context = {
    caseId: m.caseId,
    plan: {
      expect: (path: string): unknown => {
        if (!(path in m.expectations))
          throw new Error(`plan.expect('${path}'): not an expectation of ${m.caseId}`);
        return m.expectations[path];
      },
    },
    api: client(undefined),
    step: async (stepId: string, fn: () => unknown): Promise<void> => {
      await rpc({ op: "beginStep", stepId });
      try {
        await fn();
      } catch (e) {
        await rpc({ op: "endStep", stepId, error: message(e) });
        throw e;
      }
      await rpc({ op: "endStep", stepId });
    },
    verify: (stepId: string, field: string): void => {
      void rpc({ op: "verify", stepId, field }).catch(() => undefined);
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
