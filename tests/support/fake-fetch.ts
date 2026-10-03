import { readFileSync } from "node:fs";
import type { AdapterDeps, Logger } from "@qajitsu/core";

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** A route: method + URL pattern (matched against `pathname + search`) → response factory. */
export interface Route {
  readonly method?: string;
  readonly match: RegExp;
  readonly reply: (request: RecordedRequest) => Response | Promise<Response>;
}

/** Reads a fixture from `fixtures/`. */
export const fixture = (path: string): string =>
  readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8");

/** JSON response helper. */
export const jsonReply =
  (body: unknown, status = 200, headers: Record<string, string> = {}): Route["reply"] =>
  () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

/** Text response helper. */
export const textReply =
  (body: string, status = 200): Route["reply"] =>
  () =>
    new Response(body, { status });

/**
 * Deterministic in-memory `fetch` for adapter tests: no network, unmatched requests fail loudly.
 * Plays the role MSW plays in the testing rules, injected through `AdapterDeps.fetch`.
 */
export function createFakeFetch(routes: readonly Route[]): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url,
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    };
    requests.push(request);
    const route = routes.find(
      (r) => (r.method ?? "GET") === request.method && r.match.test(`${url.pathname}${url.search}`),
    );
    if (!route)
      return new Response(`no fake route for ${request.method} ${url.pathname}${url.search}`, {
        status: 404,
      });
    return route.reply(request);
  };
  return { fetch: fetch, requests };
}

/** Logger that records entries for assertions. */
export function createTestLogger(): Logger & {
  entries: { level: string; message: string; fields: unknown }[];
} {
  const entries: { level: string; message: string; fields: unknown }[] = [];
  const at =
    (level: string) =>
    (fields: Readonly<Record<string, unknown>>, message: string): void => {
      entries.push({ level, message, fields });
    };
  return { entries, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** AdapterDeps for tests: fake fetch, fixed clock, secrets from a map. */
export function testDeps(
  fetch: typeof globalThis.fetch,
  secrets: Record<string, string> = {},
): AdapterDeps & {
  logger: ReturnType<typeof createTestLogger>;
  sleep: () => Promise<void>;
  registered: string[];
} {
  const registered: string[] = [];
  return {
    registered,
    registerSecret: (value) => {
      registered.push(value);
    },
    fetch,
    logger: createTestLogger(),
    now: () => new Date("2026-10-03T10:46:00Z"),
    resolveSecret: (ref) => {
      const value = secrets[ref];
      return value === undefined
        ? Promise.reject(new Error(`unknown secret ${ref}`))
        : Promise.resolve(value);
    },
    sleep: () => Promise.resolve(),
  };
}
