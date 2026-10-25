/**
 * One request of a web case as the trusted parent saw it (REQ-EVD-09): the page's own traffic, never the spec's. `url`
 * is a path for the application's origin and `origin + path` elsewhere, already masked by the driver.
 */
export interface UiRequest {
  readonly method: string;
  readonly url: string;
  /** Playwright's resource type: `document`, `fetch`, `xhr`, `script`, `image`... */
  readonly resourceType: string;
  /** The request went to the application's own origin. */
  readonly sameOrigin: boolean;
  readonly status?: number | undefined;
  /** The browser's error when no response came (`net::ERR_TIMED_OUT`). */
  readonly failure?: string | undefined;
  /** Refused by QAJitsu's environment allowlist (INV-10). */
  readonly refused?: boolean | undefined;
  /** The browser reported a CORS block for this URL. */
  readonly cors?: boolean | undefined;
  /** Where a redirect pointed, as a path or URL. */
  readonly location?: string | undefined;
}

/** A request that went wrong in a step (REQ-EVD-09/AC1). */
export interface NetworkProblem {
  readonly kind:
    | "server-error"
    | "client-error"
    | "timeout"
    | "connection"
    | "refused-by-allowlist"
    | "cors"
    | "login-redirect";
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly detail?: string;
}

/** Problems kept per step; the evidence file says how many there were. */
const MAX_PROBLEMS = 20;
const LOGIN = /\/(log-?in|sign-?in|auth|sso)\b/i;

/**
 * The requests of a step that went wrong, in the order they were sent (REQ-EVD-09/AC1): 5xx and 4xx responses,
 * timeouts and connection errors, requests refused by the allowlist, CORS blocks and redirects to a login page. A
 * request the page cancelled itself is not a problem. Code builds this; the traffic itself never reaches an agent.
 *
 * @param requests - The step's requests, masked.
 */
export function diagnoseNetwork(requests: readonly UiRequest[]): NetworkProblem[] {
  const out: NetworkProblem[] = [];
  for (const r of requests) {
    const base = { method: r.method, url: r.url };
    if (r.refused === true)
      out.push({ ...base, kind: "refused-by-allowlist", detail: "not on the environment allowlist" });
    else if (r.cors === true)
      out.push({ ...base, kind: "cors", detail: "blocked by the browser's CORS policy" });
    else if (r.status !== undefined && r.status >= 300 && r.status < 400 && LOGIN.test(r.location ?? ""))
      out.push({
        ...base,
        kind: "login-redirect",
        status: r.status,
        detail: `redirected to ${(r.location ?? "").split("?")[0] ?? ""}`,
      });
    else if (r.status !== undefined && r.status >= 500)
      out.push({ ...base, kind: "server-error", status: r.status });
    else if (r.status !== undefined && r.status >= 400)
      out.push({ ...base, kind: "client-error", status: r.status });
    else if (r.failure !== undefined && /TIMED_OUT|timeout/i.test(r.failure))
      out.push({ ...base, kind: "timeout", detail: r.failure });
    else if (r.failure !== undefined && !/ABORTED|NS_BINDING_ABORTED|cancelled/i.test(r.failure))
      out.push({ ...base, kind: "connection", detail: r.failure });
  }
  return out.slice(0, MAX_PROBLEMS);
}

/** An API endpoint of the application a case reached (REQ-EVD-09/AC2). */
export interface ReachedEndpoint {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
}

/** Resource types that are pages or calls of the application, not assets (scripts, images, styles). */
const API_TYPES = new Set(["document", "fetch", "xhr", "eventsource", "websocket", "other"]);

/**
 * The application's pages and API endpoints the requests reached (REQ-EVD-09/AC2): same origin, a response came,
 * once per method and path (query removed), assets left out.
 *
 * @param requests - Every request of the attempt, masked.
 */
export function reachedEndpoints(requests: readonly UiRequest[]): ReachedEndpoint[] {
  const seen = new Map<string, ReachedEndpoint>();
  for (const r of requests) {
    if (!r.sameOrigin || r.status === undefined || r.refused === true || !API_TYPES.has(r.resourceType))
      continue;
    const path = r.url.split(/[?#]/)[0] ?? r.url;
    const key = `${r.method} ${path}`;
    if (!seen.has(key)) seen.set(key, { method: r.method, path, status: r.status });
  }
  return [...seen.values()].slice(0, 500);
}
