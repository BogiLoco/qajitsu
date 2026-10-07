import { isDeepStrictEqual } from "node:util";
import type {
  AssertionRecord,
  AttemptRecord,
  CapturedMessage,
  CaseMessages,
  EvidenceItem,
  ManualPrompter,
  Plan,
  VisualCheck,
  TestCase,
} from "@qajitsu/core";
import type { Masker } from "./masking.js";
import { assertSelector, type UiClient, type UiDriver, type UiOperation, type UiProperty } from "./ui.js";

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
 * `actual` is read from the last response of the step or from the live page, `expected` from the
 * approved plan. The values a spec passes are documentation only (ADR-0004).
 */
export interface CaseContext {
  readonly caseId: string;
  readonly plan: PlanAccessor;
  readonly api: ApiClient;
  /** Browser actions, performed by QAJitsu (ADR-0004). */
  readonly ui: UiClient;
  /** Runs one plan step; errors end the attempt as an error. */
  readonly step: (stepId: string, fn: () => Promise<void> | void) => Promise<void>;
  /** Records the assertion `<field>` of the step; it is evaluated before the step ends. */
  readonly verify: (stepId: string, field: string, actual?: unknown, expected?: unknown) => void;
  /** The case's inbox (REQ-ENV-08): an address for the test data, and the message the plan expects. */
  readonly inbox: InboxClient;
}

/** A received message as a spec sees it: masked, with the links it contains. */
export interface ReceivedMessage {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly body: string;
  readonly links: readonly string[];
}

/** The inbox of a case (REQ-ENV-08). */
export interface InboxClient {
  /** The inbox's e-mail address (default) or webhook URL, to put into test data. */
  readonly address: (kind?: "email" | "url") => Promise<string>;
  /**
   * Waits in step `stepId` for the message the approved plan expects there (`expect.message`); resolves undefined
   * when none arrived in time. Verify it with `verify(stepId, "message")`.
   */
  readonly wait: (stepId: string) => Promise<ReceivedMessage | undefined>;
}

// Defined in @qajitsu/core (ADR-0005) and re-exported here for spec authors and runners.
export type { AttemptRecord, EvidenceItem } from "@qajitsu/core";

/** Settings of one case attempt. */
export interface CaseRuntimeOptions {
  readonly plan: Plan;
  readonly caseId: string;
  readonly attempt: number;
  readonly baseUrl: string;
  readonly transport: ApiTransport;
  readonly masker: Masker;
  /** Origins API calls and page loads may reach (REQ-ENV-01/AC2). */
  readonly allowedOrigins: readonly string[];
  /** Headers per account alias, prepared by framework login helpers (REQ-CFG-07/AC2). */
  readonly accounts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly now: () => number;
  /** Starts the browser on first use; absent for API-only runs (REQ-EXEC-05). */
  readonly ui?: (() => Promise<UiDriver>) | undefined;
  /** Asks a person at manual steps (REQ-EXEC-11); the trusted orchestrator provides it, never a spec or agent. */
  readonly manual?: ManualPrompter | undefined;
  /** The case's message inbox (REQ-ENV-08); read by the trusted runtime only. */
  readonly messages?: CaseMessages | undefined;
  /** The locale of this run (REQ-EXEC-14), sent as `Accept-Language`. */
  readonly locale?: string | undefined;
  /** Baselines and image comparison (REQ-EXEC-12); provided by the trusted orchestrator. */
  readonly visual?: VisualCheck | undefined;
  /** Gets a copy of each step screenshot as soon as it is taken, for the live view (REQ-OBS-09); never evidence. */
  readonly onScreenshot?: ((stepId: string, png: Uint8Array) => void) | undefined;
}

/** The recorder of one attempt. Runs in the trusted process; specs only reach it through these operations. */
export interface CaseRuntime {
  /** In-process context (unit tests). The sandbox builds an equivalent proxy over IPC. */
  readonly context: CaseContext;
  readonly beginStep: (stepId: string) => void;
  readonly endStep: (stepId: string, error?: string) => Promise<void>;
  readonly call: (
    alias: string | undefined,
    method: HttpMethod,
    path: string,
    body: unknown,
    options: ApiCallOptions,
  ) => Promise<ApiTransportResponse>;
  /** Performs one browser action (REQ-EXEC-05, REQ-EXEC-07). */
  readonly uiOp: (operation: UiOperation) => Promise<void>;
  /** Computes and records an assertion from the step's last response or the live page and the approved plan. */
  readonly verify: (stepId: string, field: string) => Promise<void>;
  /** The inbox address of the case (REQ-ENV-08). */
  readonly inboxAddress: (kind: "email" | "url") => Promise<string>;
  /** Waits for the planned message of a step (REQ-ENV-08/AC2). */
  readonly inboxWait: (stepId: string) => Promise<ReceivedMessage | undefined>;
  readonly finish: (error?: unknown) => Promise<AttemptRecord>;
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
  else if (kind === "elements" && rest.length >= 2) {
    const property = rest.at(-1) as UiProperty;
    value = e.elements?.[rest.slice(0, -1).join(".")]?.[property];
  } else if (kind === "message" && rest.length === 0) value = e.message;
  else if (kind === "visual" && rest.length === 0) value = e.visual;
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

/** Recorded as the actual value when the response or page has no value at the expected place. */
export const ABSENT = "(absent)";

const ACTION = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)/i;
const PROPERTIES: readonly UiProperty[] = ["visible", "enabled", "checked", "text", "value"];

/** True when a concrete path matches a plan path like `/carts/{id}` or `/carts/:id`. */
const pathMatches = (template: string, path: string): boolean => {
  const t = template.replace(/\/+$/, "").split("/");
  const p = path.replace(/\/+$/, "").split("/");
  return t.length === p.length && t.every((seg, i) => /^(\{[^}]+\}|:\w+)$/.test(seg) || seg === p[i]);
};

/**
 * Creates the recorder of one case attempt (REQ-EXEC-02, REQ-EVD-01, REQ-EVD-02). It performs every
 * HTTP call and browser action, records evidence and computes every assertion itself; everything
 * recorded is masked.
 *
 * @param options - Plan, case, transport, browser, accounts, allowlist, masker and clock.
 */
export function createCaseRuntime(options: CaseRuntimeOptions): CaseRuntime {
  const { plan, caseId, attempt, masker } = options;
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (!planCase) throw new Error(`${caseId} is not in the approved plan`);
  const stepIds = new Set(planCase.steps.map((s) => s.id));
  const steps: { id: string; ok: boolean; error?: string; url?: string }[] = [];
  const assertions: AssertionRecord[] = [];
  const media: EvidenceItem[] = [];
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
  let driver: UiDriver | undefined;
  /** What the step did last: an API call or a UI action; decides the source of `texts` checks. */
  const lastAction = new Map<string, "api" | "ui">();
  const maskValue = (v: unknown): unknown => masker.maskJson(v);

  const browser = async (): Promise<UiDriver> => {
    if (!options.ui) throw new Error("This run has no browser; UI actions need the web runner");
    driver ??= await options.ui();
    return driver;
  };

  const beginStep = (stepId: string): void => {
    if (!stepIds.has(stepId))
      throw new Error(`step('${stepId}') is not a step of ${caseId} in the approved plan`);
    if (steps.some((s) => s.id === stepId) || currentStep !== undefined) {
      throw new Error(`step('${stepId}') ran twice or inside another step`);
    }
    currentStep = stepId;
  };

  const manualSteps = new Map(planCase.steps.filter((s) => s.manual === true).map((s) => [s.id, s] as const));
  /** One-time codes and secrets a tester may type into a note never leave the runtime (REQ-EXEC-11/AC7). */
  const maskNote = (note: string): string => masker.maskText(note).replace(/\b\d{4,8}\b/g, "***");

  /**
   * Asks a person for the outcome of a manual step (REQ-EXEC-11/AC2+AC3, ADR-0008). The answer becomes an assertion
   * with `source: manual`; the record and any attachment become evidence of the step. No answer is an error.
   */
  const askPerson = async (stepId: string): Promise<string | undefined> => {
    const planStep = manualSteps.get(stepId);
    if (!planStep) return undefined;
    if (!options.manual)
      return `manual step ${stepId} needs a person; run interactively or answer with 'qajitsu answer'`;
    const answer = await options.manual({
      caseId,
      stepId,
      attempt,
      action: planStep.action,
      instructions: planStep.instructions ?? planStep.action,
      expected: planStep.expect.description,
    });
    if (!answer) return `manual step ${stepId} was not answered in time`;
    const note = answer.note === undefined ? undefined : maskNote(answer.note);
    const record: AssertionRecord = {
      stepId,
      field: "manual",
      expected: "passed",
      actual: answer.outcome,
      pass: answer.outcome === "passed",
      source: "manual",
      by: masker.maskText(answer.by),
      at: answer.at,
      ...(note === undefined ? {} : { note }),
    };
    assertions.push(record);
    media.push({
      stepId,
      kind: "manual",
      name: `${stepId}-manual.json`,
      content: `${JSON.stringify({ ...record, instructions: planStep.instructions }, null, 2)}\n`,
    });
    if (answer.attachment) {
      const name = answer.attachment.name.replace(/[^\w.-]+/g, "_").slice(-80);
      const text = /\.(txt|log|md|json|csv|html?)$/i.test(name);
      media.push({
        stepId,
        kind: "manual",
        name: `${stepId}-${name}`,
        content: text
          ? maskNote(new TextDecoder().decode(answer.attachment.content))
          : answer.attachment.content,
      });
    }
    return undefined;
  };

  const endStep = async (stepId: string, error?: string): Promise<void> => {
    if (currentStep !== stepId) throw new Error(`step('${stepId}') ended but was not running`);
    if (error === undefined) {
      const unanswered = await askPerson(stepId);
      if (unanswered !== undefined) {
        error = unanswered;
        failure ??= unanswered;
      }
    }
    steps.push({
      id: stepId,
      ok: error === undefined,
      ...(error === undefined ? {} : { error: masker.maskText(error) }),
      ...(driver ? { url: masker.maskText(driver.url()) } : {}),
    });
    currentStep = undefined;
    // REQ-EVD-02/AC1: a screenshot after every step of a case that uses the browser.
    if (driver) {
      try {
        const png = await driver.screenshot(false);
        media.push({ stepId, kind: "screenshot", name: `${stepId}.png`, content: png });
        // REQ-OBS-09: the live view gets its own copy; what it does with it cannot change the evidence.
        try {
          options.onScreenshot?.(stepId, png.slice());
        } catch {
          // A failing live view never affects the attempt.
        }
      } catch {
        // A crashed page has no screenshot; the failure evidence still records the state.
      }
    }
  };

  const call: CaseRuntime["call"] = async (alias, method, path, body, opts) => {
    if (currentStep === undefined) throw new Error("API calls must run inside step()");
    const stepId = currentStep;
    lastAction.set(stepId, "api");
    const url = new URL(path, options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    if (!options.allowedOrigins.includes(url.origin))
      throw new Error(`URL ${url.origin} is not in the environment allowlist`);
    const accountHeaders = alias === undefined ? {} : options.accounts[alias];
    if (accountHeaders === undefined) throw new Error(`Unknown account alias '${alias ?? ""}'`);
    // Account headers win: a spec cannot replace the session of an alias.
    const headers = {
      "content-type": "application/json",
      // REQ-EXEC-14: a locale run asks the API for that locale; a spec may still set its own header.
      ...(options.locale ? { "accept-language": options.locale } : {}),
      ...opts.headers,
      ...accountHeaders,
    };
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

  const uiOp = async (operation: UiOperation): Promise<void> => {
    if (currentStep === undefined) throw new Error("UI actions must run inside step()");
    lastAction.set(currentStep, "ui");
    const d = await browser();
    switch (operation.op) {
      case "goto": {
        const url = new URL(operation.path, options.baseUrl);
        if (!options.allowedOrigins.includes(url.origin))
          throw new Error(`URL ${url.origin} is not in the environment allowlist`);
        await d.goto(url.toString());
        return;
      }
      case "back":
        await d.back();
        return;
      case "as":
        if (!(operation.alias in options.accounts))
          throw new Error(`Unknown account alias '${operation.alias}'`);
        await d.useAccount(operation.alias);
        return;
      case "click":
        await d.click(assertSelector(operation.selector));
        return;
      case "check":
      case "uncheck":
        await d.check(assertSelector(operation.selector), operation.op === "check");
        return;
      case "fill":
        await d.fill(assertSelector(operation.selector), operation.value);
        return;
      case "select":
        await d.select(assertSelector(operation.selector), operation.value);
        return;
      case "press":
        await d.press(assertSelector(operation.selector), operation.value);
        return;
      case "waitFor":
        await d.waitFor(assertSelector(operation.selector), operation.state);
        return;
    }
  };

  /** What each step's wait found: the matching message, or null when none arrived in time. */
  const waited = new Map<string, CapturedMessage | null>();
  let inbox: Awaited<ReturnType<CaseMessages["inbox"]>> | undefined;
  const attemptStart = options.now();
  const messages = (): CaseMessages => {
    if (!options.messages)
      throw new Error(
        "This run has no message capture; configure `messages` in .qa/qa.project.yaml (REQ-ENV-08)",
      );
    return options.messages;
  };
  const openInbox = async () => (inbox ??= await messages().inbox());
  const contains = (value: string | undefined, part: string | undefined): boolean =>
    part === undefined || (value ?? "").toLowerCase().includes(part.toLowerCase());
  const view = (m: CapturedMessage): ReceivedMessage => {
    const body = masker.maskText(m.body);
    return {
      ...(m.from ? { from: masker.maskText(m.from) } : {}),
      ...(m.to ? { to: masker.maskText(m.to) } : {}),
      ...(m.subject ? { subject: masker.maskText(m.subject) } : {}),
      body,
      links: [...new Set(body.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])],
    };
  };

  /**
   * Waits for the message the approved plan expects in a step (REQ-ENV-08/AC2+AC3): only messages received after the
   * attempt started count; the filter comes from the plan, never from the spec. The result and the message (masked)
   * are evidence of the step.
   */
  const inboxWait = async (stepId: string): Promise<ReceivedMessage | undefined> => {
    if (currentStep !== stepId) throw new Error(`inbox.wait('${stepId}') must run inside step('${stepId}')`);
    const filter = planCase.steps.find((x) => x.id === stepId)?.expect.message;
    if (!filter) throw new Error(`inbox.wait('${stepId}'): the plan expects no message in ${stepId}`);
    const service = messages();
    const box = await openInbox();
    const limit = (filter.within_s ?? service.timeoutMs / 1000) * 1000;
    const deadline = options.now() + limit;
    let found: CapturedMessage | undefined;
    let received: number;
    for (;;) {
      const all = (await service.capture.messages(box.id)).filter(
        (m) => Date.parse(m.receivedAt) >= attemptStart,
      );
      received = all.length;
      found = all.find(
        (m) =>
          contains(m.to, filter.to) && contains(m.subject, filter.subject) && contains(m.body, filter.body),
      );
      if (found || options.now() >= deadline) break;
      await new Promise((done) => setTimeout(done, service.pollMs ?? 2000));
    }
    waited.set(stepId, found ?? null);
    media.push({
      stepId,
      kind: "message",
      name: `${stepId}-message.json`,
      content: `${JSON.stringify(
        found
          ? { matched: true, receivedAt: found.receivedAt, kind: found.kind, ...view(found) }
          : { matched: false, received, waitedMs: limit },
        null,
        2,
      )}\n`,
    });
    return found ? view(found) : undefined;
  };

  const inboxAddress = async (kind: "email" | "url"): Promise<string> => {
    if (currentStep === undefined) throw new Error("inbox.address() must run inside step()");
    const box = await openInbox();
    return kind === "url" ? box.url : box.email;
  };

  /**
   * Compares the step's screenshot with its approved baseline (REQ-EXEC-12): over the plan's threshold → a failed
   * assertion with baseline, screenshot and diff as evidence (AC2); no baseline → a passing assertion flagged for
   * review, so the case is NEEDS_REVIEW and the screenshot is proposed as the baseline (AC3). The threshold and masks
   * come from the approved plan; baselines change only through `qajitsu baseline accept` (AC4).
   */
  const verifyVisual = async (stepId: string, field: string): Promise<void> => {
    const spec = planCase.steps.find((x) => x.id === stepId)?.expect.visual;
    if (!spec)
      throw new Error(`verify('${stepId}', 'visual'): the plan has no visual expectation in ${stepId}`);
    if (!driver) throw new Error(`verify('${stepId}', 'visual') needs the browser or device to be open`);
    if (!options.visual) throw new Error("This run has no visual comparison (REQ-EXEC-12)");
    const visual = options.visual;
    const key = `${caseId}/${stepId}-${spec.name}.${visual.variant}`;
    const threshold = spec.threshold ?? visual.threshold;
    const actual = await driver.screenshot(
      false,
      (spec.mask ?? []).map((m) => assertSelector(m)),
    );
    media.push({ stepId, kind: "screenshot", name: `${stepId}-visual-actual.png`, content: actual });
    const baseline = await visual.baseline(key);
    const expected = { baseline: key, threshold };
    if (!baseline) {
      assertions.push({
        stepId,
        field,
        expected,
        actual: "(no baseline yet: this screenshot is proposed)",
        pass: true,
        review: true,
      });
      return;
    }
    media.push({ stepId, kind: "screenshot", name: `${stepId}-visual-baseline.png`, content: baseline });
    const result = await visual.compare(baseline, actual);
    if ("sizeMismatch" in result) {
      assertions.push({ stepId, field, expected, actual: result.sizeMismatch, pass: false });
      return;
    }
    media.push({ stepId, kind: "screenshot", name: `${stepId}-visual-diff.png`, content: result.diff });
    const ratio = result.diffPixels / (result.width * result.height);
    assertions.push({
      stepId,
      field,
      expected,
      actual: { diffPixels: result.diffPixels, ratio: Number(ratio.toFixed(6)) },
      pass: ratio <= threshold,
    });
  };

  const verify = async (stepId: string, field: string): Promise<void> => {
    if (!stepIds.has(stepId)) throw new Error(`verify('${stepId}') is not a step of ${caseId}`);
    if (currentStep !== stepId) throw new Error(`verify('${stepId}') must run inside step('${stepId}')`);
    const [kind, ...rest] = field.split(".");
    const record = (expected: unknown, actual: unknown): void => {
      assertions.push({
        stepId,
        field,
        expected: maskValue(expected),
        // A missing value is recorded explicitly: JSON drops `undefined`, which would make the record unreadable.
        actual: actual === undefined ? ABSENT : maskValue(actual),
        pass: isDeepStrictEqual(actual, expected),
      });
    };
    if (kind === "visual" && rest.length === 0) {
      await verifyVisual(stepId, field);
      return;
    }
    if (kind === "message" && rest.length === 0) {
      // REQ-ENV-08/AC2: passes only when the planned message arrived in time; a timeout is a failure, never a pass.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      if (!waited.has(stepId)) await inboxWait(stepId);
      const m = waited.get(stepId);
      assertions.push({
        stepId,
        field,
        expected: maskValue(expected),
        actual: m
          ? maskValue({ to: m.to, subject: m.subject, receivedAt: m.receivedAt })
          : "(no matching message in time)",
        pass: m !== null && m !== undefined,
      });
      return;
    }
    if (kind === "elements") {
      // elements.<selector>.<property>: read from the live page by the parent.
      const property = rest.at(-1) as UiProperty | undefined;
      if (property === undefined || !PROPERTIES.includes(property) || rest.length < 2) {
        throw new Error(
          `verify('${stepId}', '${field}'): use elements.<selector>.<visible|enabled|checked|text|value>`,
        );
      }
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      if (!driver) throw new Error(`verify('${stepId}', '${field}') needs the browser to be open`);
      record(expected, await driver.property(assertSelector(rest.slice(0, -1).join(".")), property));
      return;
    }
    const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
    // Mixed cases: the page answers `texts` only when the step's last action was in the browser.
    if (kind === "texts" && driver && lastAction.get(stepId) === "ui") {
      // Visible text of the live page (REQ-EXEC-05); a response body counts only for API-only cases.
      const text = await driver.pageText();
      record(
        expected,
        typeof expected === "string" && text.includes(expected) ? expected : "(text not visible on the page)",
      );
      return;
    }
    const last = calls.filter((c) => c.stepId === stepId).at(-1);
    if (!last) throw new Error(`verify('${stepId}', '${field}') needs a response recorded in the step`);
    const action = ACTION.exec(planCase.steps.find((x) => x.id === stepId)?.action ?? "");
    if (
      action?.[1] &&
      action[2] &&
      (last.method !== action[1].toUpperCase() || !pathMatches(action[2], last.pathname))
    ) {
      throw new Error(
        `verify('${stepId}'): the last response is ${last.method} ${last.pathname}, the plan step is ${action[1].toUpperCase()} ${action[2]}`,
      );
    }
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
        `verify('${stepId}', '${field}'): only status, fields.<key>, texts.<n> and elements.<selector>.<property> can be verified`,
      );
    record(expected, actual);
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

  // verify() is fire-and-forget in specs; its evaluation is chained and awaited before the step ends.
  let pending: Promise<void> = Promise.resolve();
  const context: CaseContext = {
    caseId,
    plan: createPlanAccessor(plan, caseId),
    api: client(undefined),
    ui: {
      goto: (path) => uiOp({ op: "goto", path }),
      click: (selector) => uiOp({ op: "click", selector }),
      fill: (selector, value) => uiOp({ op: "fill", selector, value }),
      check: (selector) => uiOp({ op: "check", selector }),
      uncheck: (selector) => uiOp({ op: "uncheck", selector }),
      select: (selector, value) => uiOp({ op: "select", selector, value }),
      press: (selector, value) => uiOp({ op: "press", selector, value }),
      waitFor: (selector, state = "visible") => uiOp({ op: "waitFor", selector, state }),
      back: () => uiOp({ op: "back" }),
      as: (alias) => uiOp({ op: "as", alias }),
    },
    step: async (stepId, fn) => {
      beginStep(stepId);
      try {
        await fn();
        await pending;
        await endStep(stepId);
      } catch (error) {
        pending = Promise.resolve();
        if (currentStep === stepId) await endStep(stepId, describeError(error));
        throw error;
      }
    },
    verify: (stepId, field) => {
      // Misuse is reported at once; the evaluation itself is chained and awaited by step().
      if (!stepIds.has(stepId)) throw new Error(`verify('${stepId}') is not a step of ${caseId}`);
      if (currentStep !== stepId) throw new Error(`verify('${stepId}') must run inside step('${stepId}')`);
      pending = pending.then(() => verify(stepId, field));
    },
    inbox: {
      address: (kind = "email") => inboxAddress(kind),
      wait: (stepId) => inboxWait(stepId),
    },
  };

  return {
    context,
    beginStep,
    endStep,
    call,
    uiOp,
    verify,
    inboxAddress,
    inboxWait,
    finish: async (error) => {
      if (error !== undefined) failure = masker.maskText(describeError(error));
      // REQ-EXEC-11/AC5: a manual step the spec never ran cannot be skipped into a pass.
      for (const id of manualSteps.keys())
        if (!steps.some((s) => s.id === id)) failure ??= `manual step ${id} was not performed`;
      const evidence: EvidenceItem[] = [...media];
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
      // REQ-EVD-02/AC2: on failure a full-page screenshot and the DOM of the browser.
      if (driver && outcome !== "passed") {
        try {
          evidence.push({
            stepId: "case",
            kind: "screenshot",
            name: "failure.png",
            content: await driver.screenshot(true),
          });
          evidence.push({
            stepId: "case",
            kind: "dom",
            name: "failure.html",
            content: masker.maskText(await driver.dom()),
          });
        } catch {
          // The page is gone; video and trace from the runner still show what happened.
        }
      }
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
