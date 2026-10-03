import { isDeepStrictEqual } from "node:util";
import type { AssertionRecord, Plan, TestCase } from "@qajitsu/core";
import type { Masker } from "./masking.js";

/** HTTP methods the API client supports. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request as sent by the transport. */
export interface ApiRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** A response as returned by the transport. */
export interface ApiTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

/** Sends HTTP requests; implemented by the API runner on Playwright `APIRequestContext` (REQ-EXEC-04/AC1). */
export type ApiTransport = (request: ApiRequest) => Promise<ApiTransportResponse>;

/** A response seen by a spec. */
export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** Parsed JSON body, or the value at a dotted path (`lines.0.total`); `undefined` when absent. */
  readonly json: (path?: string) => unknown;
}

/** Options of one API call. */
export interface ApiCallOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number>>;
}

/** API client of a spec; `as(alias)` authenticates as a test account (REQ-CFG-07). */
export interface ApiClient {
  readonly get: (path: string, options?: ApiCallOptions) => Promise<ApiResponse>;
  readonly post: (path: string, body?: unknown, options?: ApiCallOptions) => Promise<ApiResponse>;
  readonly put: (path: string, body?: unknown, options?: ApiCallOptions) => Promise<ApiResponse>;
  readonly patch: (path: string, body?: unknown, options?: ApiCallOptions) => Promise<ApiResponse>;
  readonly delete: (path: string, options?: ApiCallOptions) => Promise<ApiResponse>;
  /** The same client, authenticated as an account alias such as `user:standard`. */
  readonly as: (alias: string) => ApiClient;
}

/** Read access to the approved plan's expectations (invariant 4). */
export interface PlanAccessor {
  /**
   * Expected value `<case>.<step>.<field>`: `status`, `fields.<key>`, `texts.<n>` or `description`.
   *
   * @throws {Error} When the case, step or field does not exist; the attempt then errors (BLOCKED).
   */
  readonly expect: (path: string) => unknown;
}

/**
 * What a generated spec receives (REQ-EXEC-02). The verdict of `verify()` is computed by QAJitsu:
 * `actual` is read from the last response recorded in the step and `expected` from the approved plan.
 * The values a spec passes are documentation only, so a spec cannot assert on values it made up.
 */
export interface CaseContext {
  readonly caseId: string;
  readonly plan: PlanAccessor;
  readonly api: ApiClient;
  /** Runs one plan step; errors end the attempt as an error. */
  readonly step: (stepId: string, fn: () => Promise<void> | void) => Promise<void>;
  /** Records the assertion `<field>` of the step against the last response of the step. */
  readonly verify: (stepId: string, field: string, actual?: unknown, expected?: unknown) => void;
}

/** One evidence item produced by an attempt, before it is stored. */
export interface EvidenceItem {
  readonly stepId: string;
  readonly kind: "request" | "response" | "log";
  /** File name inside the attempt folder: `S1-01.json`. */
  readonly name: string;
  readonly content: string;
}

/** Everything one attempt produced; the runner turns it into results and evidence. */
export interface AttemptRecord {
  readonly caseId: string;
  readonly attempt: number;
  readonly outcome: "passed" | "failed" | "error";
  readonly error?: string;
  readonly steps: readonly { readonly id: string; readonly ok: boolean; readonly error?: string }[];
  readonly assertions: readonly AssertionRecord[];
  readonly evidence: readonly EvidenceItem[];
}

/** Settings of one case attempt. */
export interface CaseRuntimeOptions {
  readonly plan: Plan;
  readonly caseId: string;
  readonly attempt: number;
  readonly baseUrl: string;
  readonly transport: ApiTransport;
  readonly masker: Masker;
  /** Origins API calls may reach (REQ-ENV-01/AC2). */
  readonly allowedOrigins: readonly string[];
  /** Headers per account alias, prepared by framework login helpers (REQ-CFG-07/AC2). */
  readonly accounts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly now: () => number;
}

/** The recorder of one attempt. Runs in the trusted process; specs only reach it through these operations. */
export interface CaseRuntime {
  /** In-process context (unit tests). The sandbox builds an equivalent proxy over IPC. */
  readonly context: CaseContext;
  readonly beginStep: (stepId: string) => void;
  readonly endStep: (stepId: string, error?: string) => void;
  readonly call: (
    alias: string | undefined,
    method: HttpMethod,
    path: string,
    body: unknown,
    options: ApiCallOptions,
  ) => Promise<ApiTransportResponse>;
  /** Computes and records an assertion from the step's last response and the approved plan. */
  readonly verify: (stepId: string, field: string) => void;
  readonly finish: (error?: unknown) => AttemptRecord;
}

const at = (value: unknown, path: string | undefined): unknown => {
  if (path === undefined || path === "") return value;
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "non-Error value thrown";

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const parseJson = (text: string): unknown => {
  try {
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

/**
 * Reads one expectation of a plan step (REQ-EXEC-02/AC3).
 *
 * @throws {Error} When the field does not exist in the plan.
 */
function expectationOf(planCase: TestCase, stepId: string, field: string, path: string): unknown {
  const step = planCase.steps.find((x) => x.id === stepId);
  if (!step) throw new Error(`plan.expect('${path}'): no step ${stepId} in ${planCase.id}`);
  const e = step.expect;
  const [kind, ...rest] = field.split(".");
  let value: unknown;
  if (kind === "status" && rest.length === 0) value = e.status;
  else if (kind === "description" && rest.length === 0) value = e.description;
  else if (kind === "fields" && rest.length > 0) {
    const key = rest.join(".");
    if (!e.fields || !(key in e.fields))
      throw new Error(`plan.expect('${path}'): no expected field '${key}'`);
    value = e.fields[key];
  } else if (kind === "texts" && rest.length === 1) value = e.texts?.[Number(rest[0])];
  else throw new Error(`plan.expect('${path}'): unknown field`);
  if (value === undefined) throw new Error(`plan.expect('${path}'): no expected value`);
  return value;
}

/**
 * Builds the plan accessor for one case (REQ-EXEC-02/AC3).
 *
 * @param plan - Approved plan.
 * @param caseId - The case of the running spec; expectations of other cases are refused.
 */
export function createPlanAccessor(plan: Plan, caseId: string): PlanAccessor {
  return {
    expect: (path) => {
      const [c, s, ...field] = path.split(".");
      if (c !== caseId)
        throw new Error(`plan.expect('${path}'): a spec may only read expectations of ${caseId}`);
      const planCase = plan.cases.find((x) => x.id === c);
      if (!planCase || s === undefined) throw new Error(`plan.expect('${path}'): unknown case or step`);
      return expectationOf(planCase, s, field.join("."), path);
    },
  };
}

const ACTION = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)/i;

/** True when a concrete path matches a plan path like `/carts/{id}` or `/carts/:id`. */
const pathMatches = (template: string, path: string): boolean => {
  const t = template.replace(/\/+$/, "").split("/");
  const p = path.replace(/\/+$/, "").split("/");
  return t.length === p.length && t.every((seg, i) => /^(\{[^}]+\}|:\w+)$/.test(seg) || seg === p[i]);
};

/**
 * Creates the recorder of one case attempt (REQ-EXEC-02, REQ-EVD-01). It performs every HTTP call,
 * records evidence and computes every assertion itself; everything recorded is masked.
 *
 * @param options - Plan, case, transport, accounts, allowlist, masker and clock.
 */
export function createCaseRuntime(options: CaseRuntimeOptions): CaseRuntime {
  const { plan, caseId, attempt, masker } = options;
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (!planCase) throw new Error(`${caseId} is not in the approved plan`);
  const stepIds = new Set(planCase.steps.map((s) => s.id));
  const steps: { id: string; ok: boolean; error?: string }[] = [];
  const assertions: AssertionRecord[] = [];
  const calls: {
    stepId: string;
    method: HttpMethod;
    pathname: string;
    status: number;
    text: string;
    body: unknown;
    record: Record<string, unknown>;
  }[] = [];
  let currentStep: string | undefined;
  let failure: string | undefined;
  const maskValue = (v: unknown): unknown => masker.maskJson(v);

  const beginStep = (stepId: string): void => {
    if (!stepIds.has(stepId))
      throw new Error(`step('${stepId}') is not a step of ${caseId} in the approved plan`);
    if (steps.some((s) => s.id === stepId) || currentStep !== undefined) {
      throw new Error(`step('${stepId}') ran twice or inside another step`);
    }
    currentStep = stepId;
  };

  const endStep = (stepId: string, error?: string): void => {
    if (currentStep !== stepId) throw new Error(`step('${stepId}') ended but was not running`);
    steps.push({
      id: stepId,
      ok: error === undefined,
      ...(error === undefined ? {} : { error: masker.maskText(error) }),
    });
    currentStep = undefined;
  };

  const call: CaseRuntime["call"] = async (alias, method, path, body, opts) => {
    if (currentStep === undefined) throw new Error("API calls must run inside step()");
    const stepId = currentStep;
    const url = new URL(path, options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    if (!options.allowedOrigins.includes(url.origin))
      throw new Error(`URL ${url.origin} is not in the environment allowlist`);
    const accountHeaders = alias === undefined ? {} : options.accounts[alias];
    if (accountHeaders === undefined) throw new Error(`Unknown account alias '${alias ?? ""}'`);
    // Account headers win: a spec cannot replace the session of an alias.
    const headers = { "content-type": "application/json", ...opts.headers, ...accountHeaders };
    const started = options.now();
    const response = await options.transport({
      method,
      url: url.toString(),
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const durationMs = options.now() - started;
    const parsed = parseJson(response.text);
    const maskedHeaders = masker.maskHeaders(headers);
    const curl = [
      `curl -X ${method} ${shellQuote(masker.maskText(url.toString()))}`,
      ...Object.entries(maskedHeaders).map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`),
      ...(body === undefined ? [] : [`--data ${shellQuote(JSON.stringify(maskValue(body)))}`]),
    ].join(" \\\n  ");
    calls.push({
      stepId,
      method,
      pathname: url.pathname,
      status: response.status,
      text: response.text,
      body: parsed,
      record: {
        method,
        url: masker.maskText(url.toString()),
        request: { headers: maskedHeaders, body: maskValue(body) },
        response: {
          status: response.status,
          headers: masker.maskHeaders(response.headers),
          body: parsed === undefined ? masker.maskText(response.text) : maskValue(parsed),
        },
        durationMs,
        curl,
      },
    });
    return response;
  };

  const verify = (stepId: string, field: string): void => {
    if (!stepIds.has(stepId)) throw new Error(`verify('${stepId}') is not a step of ${caseId}`);
    if (currentStep !== stepId) throw new Error(`verify('${stepId}') must run inside step('${stepId}')`);
    const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
    const last = calls.filter((c) => c.stepId === stepId).at(-1);
    if (!last) throw new Error(`verify('${stepId}', '${field}') needs a response recorded in the step`);
    const action = ACTION.exec(planCase.steps.find((s) => s.id === stepId)?.action ?? "");
    if (
      action?.[1] &&
      action[2] &&
      (last.method !== action[1].toUpperCase() || !pathMatches(action[2], last.pathname))
    ) {
      throw new Error(
        `verify('${stepId}'): the last response is ${last.method} ${last.pathname}, the plan step is ${action[1].toUpperCase()} ${action[2]}`,
      );
    }
    const [kind, ...rest] = field.split(".");
    let actual: unknown;
    if (kind === "status") actual = last.status;
    else if (kind === "fields") actual = at(last.body, rest.join("."));
    else if (kind === "texts")
      actual =
        typeof expected === "string" && last.text.includes(expected)
          ? expected
          : "(text not found in the response)";
    else
      throw new Error(
        `verify('${stepId}', '${field}'): only status, fields.<key> and texts.<n> can be verified`,
      );
    assertions.push({
      stepId,
      field,
      expected: maskValue(expected),
      actual: maskValue(actual),
      pass: isDeepStrictEqual(actual, expected),
    });
  };

  const client = (alias: string | undefined): ApiClient => {
    const send = async (
      method: HttpMethod,
      path: string,
      body: unknown,
      opts: ApiCallOptions = {},
    ): Promise<ApiResponse> => {
      const r = await call(alias, method, path, body, opts);
      const parsed = parseJson(r.text);
      return { status: r.status, headers: r.headers, text: r.text, json: (p) => at(parsed, p) };
    };
    return {
      get: (path, o) => send("GET", path, undefined, o),
      post: (path, body, o) => send("POST", path, body, o),
      put: (path, body, o) => send("PUT", path, body, o),
      patch: (path, body, o) => send("PATCH", path, body, o),
      delete: (path, o) => send("DELETE", path, undefined, o),
      as: (a) => client(a),
    };
  };

  const context: CaseContext = {
    caseId,
    plan: createPlanAccessor(plan, caseId),
    api: client(undefined),
    step: async (stepId, fn) => {
      beginStep(stepId);
      try {
        await fn();
        endStep(stepId);
      } catch (error) {
        if (currentStep === stepId) endStep(stepId, describeError(error));
        throw error;
      }
    },
    verify: (stepId, field) => {
      verify(stepId, field);
    },
  };

  return {
    context,
    beginStep,
    endStep,
    call,
    verify,
    finish: (error) => {
      if (error !== undefined) failure = masker.maskText(describeError(error));
      const evidence: EvidenceItem[] = [];
      const perStep = new Map<string, number>();
      for (const c of calls) {
        const n = (perStep.get(c.stepId) ?? 0) + 1;
        perStep.set(c.stepId, n);
        evidence.push({
          stepId: c.stepId,
          kind: "response",
          name: `${c.stepId}-${String(n).padStart(2, "0")}.json`,
          content: `${JSON.stringify({ ...c.record, assertions: assertions.filter((a) => a.stepId === c.stepId) }, null, 2)}\n`,
        });
      }
      // A failed assertion wins over a later crash: the defect was observed, so the attempt is
      // "failed" (FAILED), never hidden behind an error (BLOCKED).
      const outcome: AttemptRecord["outcome"] = assertions.some((a) => !a.pass)
        ? "failed"
        : failure !== undefined
          ? "error"
          : "passed";
      return {
        caseId,
        attempt,
        outcome,
        ...(failure === undefined ? {} : { error: failure }),
        steps,
        assertions,
        evidence,
      };
    },
  };
}
