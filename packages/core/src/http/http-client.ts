import type { z } from "zod";
import { AdapterError } from "../errors.js";

/** Options of one HTTP request made by an adapter. */
export interface HttpRequest {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | FormData;
  readonly signal?: AbortSignal | undefined;
  /**
   * Follow a redirect to another origin WITHOUT any credentials (e.g. Jira attachment content served
   * from a media host with a signed URL). Default: cross-origin redirects are refused.
   */
  readonly anonymousCrossOriginRedirect?: boolean | undefined;
}

/** HTTP client shared by adapters: typed errors, rate-limit retries, Zod-parsed JSON. */
export interface HttpClient {
  /** Sends a request and parses the JSON response with `schema`. */
  json<T extends z.ZodType>(path: string, schema: T, request?: HttpRequest): Promise<z.infer<T>>;
  /** Sends a request and returns the body as text. */
  text(path: string, request?: HttpRequest): Promise<string>;
  /** Sends a request and returns the body as bytes. */
  bytes(path: string, request?: HttpRequest): Promise<Uint8Array>;
}

/** Same-origin redirects followed before giving up; cross-origin redirects are refused. */
export const HTTP_MAX_REDIRECTS = 5;

/** Retries after HTTP 429/503 before giving up. */
export const HTTP_MAX_RETRIES = 3;

const MAX_RETRY_DELAY_MS = 60_000;

const retryDelay = (response: Response, attempt: number): number => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS);
};

/**
 * Creates an HTTP client for one service. Paths are resolved against `baseUrl`; absolute URLs are
 * allowed only on the same origin, so a response can never redirect credentials to another host.
 *
 * @param options - Service name (error codes, e.g. `JIRA`), base URL, default headers and ports.
 * @example
 * const http = createHttpClient({ service: "GITHUB", baseUrl: "https://api.github.com", headers, fetch, sleep });
 * const pr = await http.json(`/repos/${repo}/pulls/12`, PullSchema, { signal });
 */
export function createHttpClient(options: {
  readonly service: string;
  readonly baseUrl: string;
  readonly headers: () => Promise<Readonly<Record<string, string>>>;
  readonly fetch: typeof globalThis.fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): HttpClient {
  const { service, fetch } = options;
  const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason as Error);
          },
          { once: true },
        );
      }));

  const resolveUrl = (path: string): URL => {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(path.replace(/^\//, ""), base);
    if (url.origin !== base.origin) {
      throw new AdapterError(
        `${service}_FOREIGN_URL`,
        `Refusing to call ${url.origin} with ${service} credentials.`,
        {
          origin: url.origin,
        },
      );
    }
    return url;
  };

  const send = async (path: string, request: HttpRequest = {}): Promise<Response> => {
    let url = resolveUrl(path);
    let method = request.method ?? "GET";
    let body = request.body;
    let redirects = 0;
    const context = { method, path: url.pathname };
    for (let attempt = 0; ; attempt += 1) {
      request.signal?.throwIfAborted();
      // Header errors (e.g. a missing credential) surface as themselves, not as "unreachable".
      const headers = { ...(await options.headers()), ...request.headers };
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          // Redirects are followed by hand so credentials never reach another origin.
          redirect: "manual",
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new AdapterError(`${service}_UNREACHABLE`, `${service} could not be reached.`, {
          ...context,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (response.ok) return response;
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        if (redirects >= HTTP_MAX_REDIRECTS) {
          throw new AdapterError(`${service}_HTTP_ERROR`, `${service} redirected too many times.`, context);
        }
        const target = new URL(location, url);
        if (
          target.origin !== base.origin &&
          request.anonymousCrossOriginRedirect === true &&
          target.protocol === "https:"
        ) {
          // Credentials never leave the service origin: the redirected request carries no headers of ours.
          const anonymous = await fetch(target, {
            method: "GET",
            redirect: "follow",
            ...(request.signal ? { signal: request.signal } : {}),
          });
          if (anonymous.ok) return anonymous;
          throw new AdapterError(
            `${service}_HTTP_ERROR`,
            `${service} redirect target answered HTTP ${String(anonymous.status)}.`,
            { ...context, status: anonymous.status },
          );
        }
        url = resolveUrl(target.toString());
        redirects += 1;
        attempt -= 1;
        if (response.status === 303) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if ((response.status === 429 || response.status === 503) && attempt < HTTP_MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(retryDelay(response, attempt), request.signal);
        continue;
      }
      const code =
        response.status === 401 || response.status === 403
          ? "AUTH"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status === 429
              ? "RATE_LIMITED"
              : "HTTP_ERROR";
      throw new AdapterError(`${service}_${code}`, `${service} answered HTTP ${String(response.status)}.`, {
        ...context,
        status: response.status,
      });
    }
  };

  return {
    async json(path, schema, request) {
      const response = await send(path, {
        ...request,
        headers: { accept: "application/json", ...request?.headers },
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AdapterError(`${service}_MALFORMED`, `${service} returned invalid JSON.`, { path });
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new AdapterError(`${service}_MALFORMED`, `${service} returned an unexpected response shape.`, {
          path: resolveUrl(path).pathname,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      return parsed.data;
    },
    async text(path, request) {
      return (await send(path, request)).text();
    },
    async bytes(path, request) {
      return new Uint8Array(await (await send(path, request)).arrayBuffer());
    },
  };
}
