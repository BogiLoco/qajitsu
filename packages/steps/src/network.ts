import type { NetworkAnalysis, NetworkBudget } from "@qajitsu/core";

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
  /** REQ-EVD-09/AC4: from the start of the request to the end of its response, and the size received. */
  readonly durationMs?: number | undefined;
  readonly bytes?: number | undefined;
  /** The response's content type. */
  readonly contentType?: string | undefined;
  /** REQ-EVD-09/AC6: the query of the URL, masked and cut to 200 characters a value, also for other hosts. */
  readonly query?: Readonly<Record<string, string>> | undefined;
  /** REQ-EVD-09/AC6: the security headers of a page of the application, lowercased. */
  readonly securityHeaders?: Readonly<Record<string, string>> | undefined;
  /** REQ-EVD-09/AC6: the cookies the response set, with their flags. */
  readonly cookies?:
    readonly { readonly name: string; readonly secure: boolean; readonly httpOnly: boolean }[] | undefined;
  /** REQ-EVD-09/AC6: an `http:` request of an `https:` page. */
  readonly mixed?: boolean | undefined;
  /** REQ-EVD-09/AC3: the JSON body as received, kept in the trusted process only while bodies are enabled. */
  readonly bodyText?: string | undefined;
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

/** One HAR entry as far as linking goes: its method and URL. */
export interface HarRequest {
  readonly method: string;
  readonly url: string;
}

/** The method and URL of every entry of a HAR text, in order; empty when it is not a HAR. */
export function harRequests(har: string): HarRequest[] {
  try {
    const parsed = JSON.parse(har) as {
      log?: { entries?: { request?: { method?: unknown; url?: unknown } }[] };
    };
    const text = (v: unknown): string => (typeof v === "string" ? v : "");
    return (parsed.log?.entries ?? []).map((e) => ({
      method: text(e.request?.method),
      url: text(e.request?.url),
    }));
  } catch {
    return [];
  }
}

/**
 * The HAR entry of every request (REQ-EVD-09/AC7), matched in order by method and URL: a request's URL is its path
 * (and query) on the application's origin, its origin and path elsewhere.
 *
 * @param requests - The attempt's requests in the order they were sent.
 * @param har - The entries of the attempt's `network.har`.
 * @param appOrigin - The application's origin.
 * @returns The HAR index of each request, or undefined when the HAR does not hold it.
 */
export function linkHar(
  requests: readonly UiRequest[],
  har: readonly HarRequest[],
  appOrigin: string,
): (number | undefined)[] {
  const key = (url: string): string => {
    try {
      const u = new URL(url);
      return u.origin === appOrigin ? `${u.pathname}${u.search}` : `${u.origin}${u.pathname}`;
    } catch {
      return url;
    }
  };
  const keys = har.map((h) => key(h.url));
  let next = 0;
  return requests.map((r) => {
    for (let i = next; i < har.length; i++)
      if (har[i]?.method === r.method && keys[i] === r.url) {
        next = i + 1;
        return i;
      }
    return undefined;
  });
}

/** The structure of a JSON value, without its values (REQ-EVD-09/AC5): `{id:number,lines:[{sku:string}]}`. */
export function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${shapeOf(value[0])}]`;
  if (typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${shapeOf((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return typeof value;
}

const SECRET_PARAM =
  /^(access_?token|id_?token|refresh_?token|token|api_?key|apikey|secret|client_secret|password|passwd|pwd|session(_?id)?|sid|auth|jwt)$/i;
const PERSONAL_PARAM = /^(e-?mail|phone|tel|mobile|ssn|pesel|iban|card(_?number)?|dob|birth_?date)$/i;
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** The security headers every page of the application should send (REQ-EVD-09/AC6). */
const PAGE_HEADERS = ["content-security-policy", "x-content-type-options"] as const;

/** What the analysis needs besides the requests. */
export interface TrafficAnalysisOptions {
  /** The application is served over `https:`: then HSTS and `Secure` cookies are expected too. */
  readonly appSecure: boolean;
  readonly budget?: NetworkBudget | undefined;
  /** AC3: keep JSON bodies up to this size, masked; a body that still looks like a secret is dropped. */
  readonly bodies?:
    | {
        readonly maxBytes: number;
        readonly mask: (value: unknown) => unknown;
        readonly looksSecret: (text: string) => boolean;
      }
    | undefined;
  /** The HAR entry of each request, in the order of `steps` and their requests. */
  readonly har?: readonly (number | undefined)[] | undefined;
}

/**
 * Code's analysis of a web attempt's traffic (REQ-EVD-09/AC3..AC6): per step the number, size and slowest of its
 * requests with the budget it went over (AC4); tokens or personal data in URLs, mixed content, missing security headers
 * and cookies without `Secure` or `HttpOnly` (AC6); the application's endpoints with the shape of their answers (AC5);
 * and, when the project enables them, the masked JSON bodies the contract check reads (AC3). Every finding names its
 * HAR entry (AC7). Nothing here is a status (invariant 1).
 *
 * @param steps - Each step's requests, masked, in order.
 * @param options - See {@link TrafficAnalysisOptions}.
 */
export function analyzeTraffic(
  steps: readonly { readonly stepId: string; readonly requests: readonly UiRequest[] }[],
  options: TrafficAnalysisOptions,
): NetworkAnalysis {
  const out: NetworkAnalysis = { steps: [], security: [], contract: [], bodies: [], endpoints: [] };
  const endpoints = new Map<string, NetworkAnalysis["endpoints"][number]>();
  const reported = new Set<string>();
  const finding = (f: NetworkAnalysis["security"][number]): void => {
    const key = `${f.kind}|${f.url.split("?")[0] ?? ""}|${f.detail}`;
    if (reported.has(key) || out.security.length >= 200) return;
    reported.add(key);
    out.security.push(f);
  };
  let n = 0;
  for (const { stepId, requests } of steps) {
    const timed: NetworkAnalysis["steps"][number]["slowest"] = [];
    let bytes = 0;
    for (const r of requests) {
      const har = options.har?.[n];
      n += 1;
      const ref = { stepId, method: r.method, url: r.url, ...(har === undefined ? {} : { har }) };
      bytes += r.bytes ?? 0;
      if (r.durationMs !== undefined) timed.push({ ...ref, durationMs: Math.round(r.durationMs) });
      // AC6: what a URL gives away, to the application or to anyone else.
      for (const [name, value] of Object.entries(r.query ?? {})) {
        if (SECRET_PARAM.test(name) || JWT.test(value))
          finding({
            ...ref,
            kind: "secret-in-url",
            detail: `query parameter "${name}" carries a token or secret`,
          });
        else if (PERSONAL_PARAM.test(name) || EMAIL.test(value))
          finding({
            ...ref,
            kind: "personal-data-in-url",
            detail: `query parameter "${name}" carries personal data`,
          });
      }
      if (r.mixed === true)
        finding({ ...ref, kind: "mixed-content", detail: "an http: request of an https: page" });
      if (r.sameOrigin && r.resourceType === "document" && r.status !== undefined && r.status < 300) {
        const h = r.securityHeaders ?? {};
        for (const name of PAGE_HEADERS)
          if (h[name] === undefined) finding({ ...ref, kind: "missing-header", detail: `no ${name} header` });
        if (
          h["x-frame-options"] === undefined &&
          !/frame-ancestors/i.test(h["content-security-policy"] ?? "")
        )
          finding({ ...ref, kind: "missing-header", detail: "no x-frame-options header or frame-ancestors" });
        if (options.appSecure && h["strict-transport-security"] === undefined)
          finding({ ...ref, kind: "missing-header", detail: "no strict-transport-security header" });
      }
      for (const c of r.cookies ?? []) {
        if (!c.httpOnly)
          finding({ ...ref, kind: "insecure-cookie", detail: `cookie "${c.name}" without HttpOnly` });
        if (options.appSecure && !c.secure)
          finding({ ...ref, kind: "insecure-cookie", detail: `cookie "${c.name}" without Secure` });
      }
      // AC3 + AC5: the application's answers, with their shape and, when enabled, their masked body.
      if (!r.sameOrigin || r.status === undefined || r.refused === true || !API_TYPES.has(r.resourceType))
        continue;
      let body: unknown;
      if (options.bodies && r.bodyText !== undefined && r.bodyText.length <= options.bodies.maxBytes)
        try {
          body = options.bodies.mask(JSON.parse(r.bodyText));
        } catch {
          body = undefined;
        }
      if (body !== undefined && options.bodies?.looksSecret(JSON.stringify(body)) === true) body = undefined;
      if (body !== undefined && out.bodies.length < 500) out.bodies.push({ ...ref, status: r.status, body });
      const path = r.url.split(/[?#]/)[0] ?? r.url;
      const key = `${r.method} ${path}`;
      if (!endpoints.has(key) && endpoints.size < 500)
        endpoints.set(key, {
          method: r.method,
          path,
          status: r.status,
          ...(body === undefined ? {} : { shape: shapeOf(body).slice(0, 2000) }),
        });
    }
    // AC4: the step's traffic and the budget it went over; a warning, never a status.
    timed.sort((a, b) => b.durationMs - a.durationMs);
    const warnings: string[] = [];
    const budget = options.budget;
    const slowest = timed[0];
    if (budget?.request_ms !== undefined && slowest && slowest.durationMs > budget.request_ms)
      warnings.push(
        `${slowest.method} ${slowest.url} took ${String(slowest.durationMs)} ms, the budget is ${String(budget.request_ms)} ms`,
      );
    if (budget?.step_requests !== undefined && requests.length > budget.step_requests)
      warnings.push(`${String(requests.length)} requests, the budget is ${String(budget.step_requests)}`);
    if (budget?.step_kb !== undefined && bytes > budget.step_kb * 1024)
      warnings.push(
        `${String(Math.round(bytes / 1024))} kB received, the budget is ${String(budget.step_kb)} kB`,
      );
    out.steps.push({ stepId, requests: requests.length, bytes, slowest: timed.slice(0, 3), warnings });
  }
  out.endpoints.push(...endpoints.values());
  return out;
}

/** A change of the application's traffic since the last run of the same plan (REQ-EVD-09/AC5). */
export interface NetworkChange {
  readonly change: "appeared" | "disappeared" | "status" | "shape";
  readonly method: string;
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

/**
 * What changed between the endpoints of two runs of the same plan (REQ-EVD-09/AC5): endpoints that appeared or
 * disappeared, and those whose status or answer's shape changed (a shape only when both runs kept bodies).
 *
 * @param before - Endpoints of the earlier run.
 * @param after - Endpoints of this run.
 */
export function diffNetwork(
  before: readonly NetworkAnalysis["endpoints"][number][],
  after: readonly NetworkAnalysis["endpoints"][number][],
): NetworkChange[] {
  const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;
  const old = new Map(before.map((e) => [key(e), e]));
  const now = new Map(after.map((e) => [key(e), e]));
  const out: NetworkChange[] = [];
  for (const [k, e] of now) {
    const was = old.get(k);
    if (!was) out.push({ change: "appeared", method: e.method, path: e.path, after: String(e.status) });
    else if (was.status !== e.status)
      out.push({
        change: "status",
        method: e.method,
        path: e.path,
        before: String(was.status),
        after: String(e.status),
      });
    else if (was.shape !== undefined && e.shape !== undefined && was.shape !== e.shape)
      out.push({ change: "shape", method: e.method, path: e.path, before: was.shape, after: e.shape });
  }
  for (const [k, e] of old)
    if (!now.has(k))
      out.push({ change: "disappeared", method: e.method, path: e.path, before: String(e.status) });
  return out;
}

/**
 * Each step's slowest request against the last run of the same plan (REQ-EVD-09/AC4): a line for every step that
 * became at least twice as slow and 200 ms slower.
 *
 * @param before - Steps of the earlier run's analysis.
 * @param after - Steps of this run's analysis.
 */
export function comparePerformance(
  before: readonly NetworkAnalysis["steps"][number][],
  after: readonly NetworkAnalysis["steps"][number][],
): string[] {
  const old = new Map(before.map((s) => [s.stepId, s.slowest[0]?.durationMs]));
  return after.flatMap((s) => {
    const was = old.get(s.stepId);
    const now = s.slowest[0];
    return was !== undefined && now && now.durationMs >= 2 * was && now.durationMs - was >= 200
      ? [
          `${s.stepId}: ${now.method} ${now.url} took ${String(now.durationMs)} ms, ${String(was)} ms in the last run`,
        ]
      : [];
  });
}
