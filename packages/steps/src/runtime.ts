import { isDeepStrictEqual } from "node:util";
import type {
  AssertionRecord,
  AttemptRecord,
  CapturedMessage,
  CaseMessages,
  CredentialLookup,
  EvidenceItem,
  ManualPrompter,
  Plan,
  ScreenBox,
  ScreenMark,
  VisualCheck,
  TestCase,
} from "@qajitsu/core";
import { plannedFields, retryAfterMs, type TrafficPolicy } from "@qajitsu/core";
import { createStreams, type ApiStream, type StreamKind, type StreamTransport } from "./streams.js";
import { soapEnvelope, xmlValue } from "./xml.js";
import { checkGesture } from "./gestures.js";
import type { Masker } from "./masking.js";
import {
  diagnoseNetwork,
  reachedEndpoints,
  type NetworkProblem,
  type ReachedEndpoint,
  type UiRequest,
} from "./network.js";
import {
  assertSelector,
  pngDimensions,
  type UiClient,
  type UiDriver,
  type UiFile,
  type UiOperation,
  type UiProperty,
} from "./ui.js";
import { csvRows, generateFile, isTextType, mimeOf, sha256Hex, type DownloadedFile } from "./web-files.js";

/** HTTP methods the API client supports. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A request body other than JSON (REQ-EXEC-45/AC1), made by `api.multipart()`, `api.form()`, `api.binary()` and
 * `api.text()`. Files are named by their key in the case's plan (`files`), never by a path or with bytes.
 */
export type ApiBody =
  | {
      readonly __qjBody: "multipart";
      readonly fields?: Readonly<Record<string, string>>;
      /** Form field name to the plan's file key. */
      readonly files?: Readonly<Record<string, string>>;
    }
  | { readonly __qjBody: "form"; readonly fields: Readonly<Record<string, string>> }
  | { readonly __qjBody: "binary"; readonly file: string }
  | { readonly __qjBody: "text"; readonly text: string; readonly type?: string }
  | {
      readonly __qjBody: "soap";
      readonly body: string;
      readonly action?: string;
      readonly version?: "1.1" | "1.2";
    };

/** A non-JSON body as the transport sends it: files resolved from the plan by the runtime. */
export type ApiPayload =
  | {
      readonly kind: "multipart";
      readonly fields: Readonly<Record<string, string>>;
      readonly files: Readonly<Record<string, UiFile>>;
    }
  | { readonly kind: "form"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "bytes"; readonly data: Uint8Array; readonly type: string };

/** A request as sent by the transport. */
export interface ApiRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body. */
  readonly body?: unknown;
  /** A multipart, form, binary or text body (REQ-EXEC-45/AC1); set instead of `body`. */
  readonly payload?: ApiPayload;
}

/** A response as returned by the transport. */
export interface ApiTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /** The body's bytes, so a binary response (a file, an image, a PDF) is kept as it is (REQ-EXEC-45/AC2). */
  readonly bytes?: Uint8Array;
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
  /** The value of an XPath over the local names of an XML or SOAP body (REQ-EXEC-50/AC3); `undefined` when absent. */
  readonly xml: (xpath: string) => Promise<unknown>;
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
  /**
   * Opens a WebSocket to a path of the environment with this client's account (REQ-EXEC-47/AC1). Check its messages
   * with `verify(step, "messages.<n>.<path>" | "messages.count", ...)`: the check waits for them itself.
   */
  readonly websocket: (
    path: string,
    options?: { readonly protocols?: readonly string[] },
  ) => Promise<ApiStream>;
  /** Subscribes to a server-sent events stream of the environment with this client's account (REQ-EXEC-47/AC2). */
  readonly events: (path: string) => Promise<ApiStream>;
  /** A `multipart/form-data` body: text fields and files of the plan by key, `{ field: "<file key>" }`. */
  readonly multipart: (parts: {
    readonly fields?: Readonly<Record<string, string>>;
    readonly files?: Readonly<Record<string, string>>;
  }) => ApiBody;
  /** An `application/x-www-form-urlencoded` body. */
  readonly form: (fields: Readonly<Record<string, string>>) => ApiBody;
  /** The bytes of a file of the plan, by key, as the raw body with its type. */
  readonly binary: (fileKey: string) => ApiBody;
  /** A plain text body, `text/plain` unless another text type is given. */
  readonly text: (text: string, type?: string) => ApiBody;
  /**
   * A GraphQL query or mutation (REQ-EXEC-48/AC2), sent as `POST /graphql` (or `options.path`) with its variables;
   * expectations read `data.<field>` and `errors` like JSON fields.
   */
  /**
   * A SOAP request (REQ-EXEC-50/AC1): the body element is wrapped in the envelope of SOAP 1.1 (default) or 1.2 with
   * its content type and `SOAPAction`, and sent as `POST <path>`.
   */
  readonly soap: (
    path: string,
    body: string,
    options?: ApiCallOptions & { readonly action?: string; readonly version?: "1.1" | "1.2" },
  ) => Promise<ApiResponse>;
  readonly graphql: (
    query: string,
    variables?: Readonly<Record<string, unknown>>,
    options?: ApiCallOptions & { readonly path?: string },
  ) => Promise<ApiResponse>;
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
  /** Records created for this attempt (REQ-EXEC-53): `data.get("lamp").id`. */
  readonly data: TestDataClient;
}

/** The records the plan's `test_data` created for the attempt (REQ-EXEC-53/AC1). */
export interface TestDataClient {
  /**
   * What the application answered when the record was created.
   *
   * @throws {Error} When the case's plan has no record with this name; the attempt then errors.
   */
  readonly get: (name: string) => Readonly<Record<string, unknown>>;
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
  /** Account secrets for `ui.fillSecret` (REQ-EXEC-67/AC3), held by the parent only. */
  readonly credential?: CredentialLookup | undefined;
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
  /** Records created for this attempt by name (REQ-EXEC-53/AC1), provided by the runner. */
  readonly testData?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Waits between the rounds of a step with a planned wait (REQ-EXEC-46); `setTimeout` when not given. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Starts the browser on first use; absent for API-only runs (REQ-EXEC-05). */
  readonly ui?: (() => Promise<UiDriver>) | undefined;
  /**
   * Opens another browser session of the case by name (REQ-EXEC-62/AC1): its own browser context with its own cookies
   * and storage, closed and recorded by the runner with the attempt.
   */
  readonly session?: ((name: string) => Promise<UiDriver>) | undefined;
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
  /** Draws numbered red boxes on a copy of a PNG (REQ-EVD-08); provided by the trusted runner. */
  readonly annotate?: ((png: Uint8Array, marks: readonly ScreenMark[]) => Promise<Uint8Array>) | undefined;
  /** Reads a file of the project's `.qa/fixtures/` for an upload (REQ-EXEC-38/AC1); provided by the orchestrator. */
  readonly fixture?: ((path: string) => Promise<Uint8Array>) | undefined;
  /** Text of a downloaded PDF or XLSX file for `download.*` checks (REQ-EXEC-38/AC2); provided by the CLI. */
  readonly extractText?: ((name: string, data: Uint8Array) => Promise<string | undefined>) | undefined;
  /** The page's test hook for `state.*` checks (REQ-EXEC-56/AC2); `__QA_STATE__` by default. */
  readonly testStateHook?: string | undefined;
  /** How long a download or a new page may take, in ms (15 s by default). */
  readonly waitTimeoutMs?: number | undefined;
  /**
   * The run's limits for a shared environment (REQ-EXEC-54): the rate every request waits for, how long the case may
   * wait out `429` and `503`, and the idempotency header. Without it: no rate, a 30 s budget, `Idempotency-Key`.
   */
  readonly traffic?: Pick<TrafficPolicy, "throttle" | "retryBudgetMs" | "idempotencyHeader"> | undefined;
  /** Opens WebSockets and event streams (REQ-EXEC-47); without it a spec that opens one errors. */
  readonly streams?: StreamTransport | undefined;
}

/** The recorder of one attempt. Runs in the trusted process; specs only reach it through these operations. */
export interface CaseRuntime {
  /** In-process context (unit tests). The sandbox builds an equivalent proxy over IPC. */
  readonly context: CaseContext;
  readonly beginStep: (stepId: string) => void;
  readonly endStep: (stepId: string, error?: string) => Promise<void>;
  /**
   * After a round of a step's actions and checks (REQ-EXEC-46): `again` with the delay when the plan's wait allows
   * another round and a check did not hold; that round's checks then become evidence of the wait.
   */
  readonly pollRound: (stepId: string) => { readonly again: boolean; readonly delayMs: number };
  readonly call: (
    alias: string | undefined,
    method: HttpMethod,
    path: string,
    body: unknown,
    options: ApiCallOptions,
  ) => Promise<ApiTransportResponse>;
  /** Opens a stream of the current step for the sandbox (REQ-EXEC-47); returns its handle number. */
  readonly openStream: (
    alias: string | undefined,
    kind: StreamKind,
    path: string,
    protocols?: readonly string[],
  ) => Promise<number>;
  /** Sends on, reads or closes a stream opened with `openStream`. */
  readonly streamOp: (handle: number, op: "send" | "messages" | "close", data?: unknown) => Promise<unknown>;
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
  } else if (kind === "messages" && rest.length > 0) {
    const key = rest.join(".");
    if (!e.messages || !(key in e.messages))
      throw new Error(`plan.expect('${path}'): no expected message '${key}'`);
    value = e.messages[key];
  } else if (kind === "xml" && rest.length > 0) {
    const key = rest.join(".");
    if (!e.xml || !(key in e.xml)) throw new Error(`plan.expect('${path}'): no expected XPath '${key}'`);
    value = e.xml[key];
  } else if (kind === "texts" && rest.length === 1) value = e.texts?.[Number(rest[0])];
  else if (kind === "elements" && rest.length >= 2) {
    const property = rest.at(-1) as UiProperty;
    value = e.elements?.[rest.slice(0, -1).join(".")]?.[property];
  } else if (kind === "download" && rest.length >= 1) {
    const d = e.download;
    const [part, ...more] = rest;
    if (part === "texts" && more.length === 1) value = d?.texts?.[Number(more[0])];
    else if (part === "fields" && more.length > 0) value = d?.fields?.[more.join(".")];
    else if (part === "size" && more.length === 0)
      value =
        d?.min_bytes === undefined && d?.max_bytes === undefined
          ? undefined
          : { min_bytes: d.min_bytes, max_bytes: d.max_bytes };
    else if (
      (part === "name" || part === "type" || part === "sha256" || part === "rows" || part === "count") &&
      more.length === 0
    )
      value = d?.[part];
    else throw new Error(`plan.expect('${path}'): unknown download field`);
  } else if (kind === "dialog" && rest.length === 1 && (rest[0] === "type" || rest[0] === "message")) {
    value = e.dialog?.[rest[0]];
  } else if (kind === "state" && rest.length >= 1) {
    const key = rest.join(".");
    if (!e.state || !(key in e.state)) throw new Error(`plan.expect('${path}'): no expected state '${key}'`);
    value = e.state[key];
  } else if (kind === "websocket" && rest.length === 2 && (rest[0] === "received" || rest[0] === "sent")) {
    value = e.websocket?.[rest[0]]?.[Number(rest[1])];
  } else if (kind === "manifest" && rest.length === 1) {
    const part = rest[0] ?? "";
    if (!["name", "short_name", "start_url", "display", "icons", "controlled"].includes(part))
      throw new Error(`plan.expect('${path}'): unknown manifest field`);
    value = e.manifest?.[part as keyof NonNullable<typeof e.manifest>];
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
const PROPERTIES: readonly UiProperty[] = ["visible", "enabled", "checked", "text", "value", "in_viewport"];

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
  const steps: { id: string; ok: boolean; error?: string; url?: string; network?: NetworkProblem[] }[] = [];
  /** The gestures of each step with their fingers' paths, drawn on the step's screenshot (REQ-EXEC-41/AC3). */
  const gesturesOf = new Map<
    string,
    { kind: string; fingers: readonly (readonly { x: number; y: number }[])[] }[]
  >();
  /** Fields `ui.fillSecret` typed into, masked in every screenshot of the case (REQ-EXEC-67/AC4). */
  const secretFields = new Set<string>();
  /** Every request the page sent (REQ-EVD-09), as the parent saw it, masked by the driver. */
  const traffic: UiRequest[] = [];
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
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const streams = createStreams({
    transport: options.streams,
    baseUrl: options.baseUrl,
    allowedOrigins: options.allowedOrigins,
    masker,
    now: options.now,
    sleep,
  });
  const streamHandles: ApiStream[] = [];
  /** REQ-EXEC-47/AC1+AC2: a stream of the current step, opened by this process with the account's authentication. */
  const openStream = async (
    alias: string | undefined,
    kind: StreamKind,
    path: string,
    protocols?: readonly string[],
  ): Promise<ApiStream> => {
    if (currentStep === undefined) throw new Error("streams must be opened inside step()");
    const accountHeaders = alias === undefined ? {} : options.accounts[alias];
    if (accountHeaders === undefined) throw new Error(`Unknown account alias '${alias ?? ""}'`);
    lastAction.set(currentStep, "api");
    return streams.open(currentStep, kind, path, accountHeaders, protocols);
  };

  /** Browser sessions by name (REQ-EXEC-62); `main` is the case's first one. `driver` is the active session's. */
  const sessions = new Map<string, UiDriver>();
  let activeSession = "main";
  const browser = async (): Promise<UiDriver> => {
    if (!options.ui) throw new Error("This run has no browser; UI actions need the web runner");
    if (activeSession === "main" && !sessions.has("main")) sessions.set("main", await options.ui());
    driver = sessions.get(activeSession);
    if (!driver) throw new Error(`no browser session ${activeSession}`);
    return driver;
  };
  /** Every open session's driver, the main one first, with its name. */
  const openSessions = (): [string, UiDriver][] => [...sessions];
  /** A web action the driver must offer (ADR-0013); a native app or another runner refuses it with the reason. */
  const need = <K extends keyof UiDriver>(d: UiDriver, key: K, what: string): NonNullable<UiDriver[K]> => {
    const f = d[key];
    if (f === undefined)
      throw new Error(
        `${what} is not available ${planCase.type === "mobile" ? "in native apps yet" : "in this runner"}`,
      );
    return f;
  };
  const waitMs = options.waitTimeoutMs ?? 15_000;
  /** What each step downloaded (REQ-EXEC-38/AC2), the last file, and how many (REQ-EXEC-61/AC4). */
  const downloads = new Map<string, DownloadedFile>();
  const downloadCount = new Map<string, number>();
  /** Dialogs each step showed (REQ-EXEC-61/AC1). */
  const dialogsOf = new Map<string, { type: string; message: string; answer: string }[]>();
  const collectDialogs = (stepId: string): void => {
    const shown = openSessions().flatMap(([, d]) => d.takeDialogs?.() ?? []);
    if (shown.length > 0) dialogsOf.set(stepId, [...(dialogsOf.get(stepId) ?? []), ...shown]);
  };
  /** Every UI action with the page it went to (REQ-EXEC-39/AC2), masked; case evidence `ui-actions.json`. */
  const actions: Record<string, unknown>[] = [];
  /** A case file by its plan key (REQ-EXEC-38/AC1): never a path or bytes from the spec. */
  const caseFile = async (key: string, by = "ui.upload"): Promise<UiFile> => {
    const spec = Object.hasOwn(planCase.files ?? {}, key) ? planCase.files?.[key] : undefined;
    if (!spec) throw new Error(`${by}: '${key.slice(0, 40)}' is not a file of ${caseId} in the plan`);
    if ("fixture" in spec) {
      if (!options.fixture) throw new Error("This run has no fixtures (.qa/fixtures/) for uploads");
      const name = spec.fixture.split("/").at(-1) ?? spec.fixture;
      return { name, type: mimeOf(name), data: await options.fixture(spec.fixture) };
    }
    return { name: spec.name, type: spec.type, data: generateFile(spec) };
  };
  /** A file as evidence: text masked; a binary file whose text holds a secret is kept as its masked text. */
  const fileEvidence = async (
    stepId: string,
    kind: "upload" | "download",
    file: { name: string; type: string; data: Uint8Array },
  ): Promise<{ readonly name: string; readonly text: string | undefined }> => {
    const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    const name = `${stepId}-${kind}-${safe}`;
    if (isTextType(file.type)) {
      const text = new TextDecoder().decode(file.data);
      media.push({ stepId, kind, name, content: masker.maskText(text) });
      return { name, text };
    }
    const text = await options.extractText?.(file.name, file.data).catch(() => undefined);
    if (text !== undefined && masker.containsSecret(text)) {
      media.push({ stepId, kind, name: `${name}.masked.txt`, content: masker.maskText(text) });
      return { name: `${name}.masked.txt`, text };
    }
    media.push({ stepId, kind, name, content: file.data });
    return { name, text };
  };

  /** Rounds of steps with a planned wait (REQ-EXEC-46): start time, where the round's checks begin, and the rounds. */
  const waits = new Map<
    string,
    {
      startedAt: number;
      from: number;
      rounds: { atMs: number; checks: { field: string; actual: unknown; pass: boolean }[] }[];
      met: boolean;
    }
  >();

  const beginStep = (stepId: string): void => {
    if (!stepIds.has(stepId))
      throw new Error(`step('${stepId}') is not a step of ${caseId} in the approved plan`);
    if (steps.some((s) => s.id === stepId) || currentStep !== undefined) {
      throw new Error(`step('${stepId}') ran twice or inside another step`);
    }
    currentStep = stepId;
    if (planCase.steps.find((s) => s.id === stepId)?.wait)
      waits.set(stepId, { startedAt: options.now(), from: assertions.length, rounds: [], met: false });
  };

  /**
   * REQ-EXEC-46/AC1+AC3: decides whether a step with a planned wait runs another round. The plan alone sets the
   * timeout and interval; a round with no checks, or after the timeout, ends the waiting, and its checks decide.
   */
  const pollRound: CaseRuntime["pollRound"] = (stepId) => {
    const w = waits.get(stepId);
    const stepPlan = planCase.steps.find((s) => s.id === stepId);
    const planned = stepPlan?.wait;
    if (!w || !stepPlan || !planned || currentStep !== stepId) return { again: false, delayMs: 0 };
    const round = assertions.slice(w.from);
    const atMs = options.now() - w.startedAt;
    w.rounds.push({
      atMs,
      checks: round.map((a) => ({ field: a.field, actual: maskValue(a.actual), pass: a.pass })),
    });
    // Met only when the round checked every field the plan expects in the step, and each held: a round that leaves
    // out the failing check cannot stand in for it.
    const checked = new Set(round.map((a) => a.field));
    w.met =
      round.length > 0 &&
      round.every((a) => a.pass) &&
      plannedFields(stepPlan.expect).every((f) => checked.has(f));
    const intervalMs = Math.round(planned.interval_s * 1000);
    if (w.met) return { again: false, delayMs: 0 };
    if (atMs + intervalMs > planned.timeout_s * 1000) {
      // Not met in time while every check of the last round held: a planned check was left out, which is a failure.
      if (round.every((a) => a.pass))
        assertions.push({
          stepId,
          field: "wait",
          expected: `every planned check of ${stepId} holds within ${String(planned.timeout_s)} s`,
          actual: `the last round checked ${[...checked].join(", ") || "nothing"}`,
          pass: false,
        });
      return { again: false, delayMs: 0 };
    }
    // The round did not hold: its checks are kept in the wait's evidence, the next round checks again.
    assertions.splice(w.from);
    return { again: true, delayMs: intervalMs };
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
    // REQ-EXEC-47/AC4: the page's WebSocket frames of the step are evidence, masked.
    const frames = openSessions().flatMap(([, d]) => d.takeSocketFrames?.() ?? []);
    if (frames.length > 0)
      media.push({
        stepId,
        kind: "log",
        name: `${stepId}-websocket.json`,
        content: `${JSON.stringify(maskValue(frames), null, 2)}\n`,
      });
    // REQ-EVD-09/AC1: the requests the step sent; what went wrong is shown next to a failed or blocked step.
    const sent = openSessions().flatMap(([, d]) => d.takeNetwork?.() ?? []);
    traffic.push(...sent);
    const failedHere = error !== undefined || assertions.some((a) => a.stepId === stepId && !a.pass);
    const problems = failedHere ? (maskValue(diagnoseNetwork(sent)) as NetworkProblem[]) : [];
    if (problems.length > 0)
      media.push({
        stepId,
        kind: "log",
        name: `${stepId}-network.json`,
        content: `${JSON.stringify({ requests: sent.length, problems }, null, 2)}\n`,
      });
    const w = waits.get(stepId);
    const planned = planCase.steps.find((s) => s.id === stepId)?.wait;
    if (w && planned && w.rounds.length > 0) {
      const waitedMs = w.rounds.at(-1)?.atMs ?? 0;
      media.push({
        stepId,
        kind: "log",
        name: `${stepId}-wait.json`,
        content: `${JSON.stringify(
          {
            timeout_s: planned.timeout_s,
            interval_s: planned.interval_s,
            waitedMs,
            met: w.met,
            rounds: w.rounds,
          },
          null,
          2,
        )}\n`,
      });
    }
    steps.push({
      id: stepId,
      ok: error === undefined,
      ...(w && w.rounds.length > 0
        ? { wait: { waitedMs: w.rounds.at(-1)?.atMs ?? 0, rounds: w.rounds.length, met: w.met } }
        : {}),
      ...(error === undefined ? {} : { error: masker.maskText(error) }),
      ...(driver ? { url: masker.maskText(driver.url()) } : {}),
      ...(problems.length > 0 ? { network: problems } : {}),
    });
    currentStep = undefined;
    // REQ-EXEC-61/AC1: every dialog of the step is evidence, with how it was answered.
    collectDialogs(stepId);
    const shown = dialogsOf.get(stepId);
    if (shown && shown.length > 0)
      media.push({
        stepId,
        kind: "log",
        name: `${stepId}-dialogs.json`,
        content: `${JSON.stringify(maskValue(shown), null, 2)}\n`,
      });
    // REQ-EVD-02/AC1: a screenshot after every step of a case that uses the browser; REQ-EXEC-62/AC2: one per
    // session, named after it.
    for (const [name, d] of openSessions()) {
      if (name === "main") continue;
      try {
        const png = await d.screenshot(false, [...secretFields]);
        media.push({ stepId, kind: "screenshot", name: `${stepId}-${name}.png`, content: png });
      } catch {
        // A crashed page has no screenshot.
      }
    }
    const main = sessions.get("main");
    if (main) {
      try {
        // REQ-EXEC-67/AC4: fields that got an account secret are blacked out.
        const png = await main.screenshot(false, [...secretFields]);
        media.push({ stepId, kind: "screenshot", name: `${stepId}.png`, content: png });
        // The red boxes are drawn from the active page's elements: only when that is the main session.
        if (activeSession === "main") await annotateStep(stepId, png);
        await drawGestures(stepId, png);
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

  /**
   * A body descriptor of `api.multipart()`, `api.form()`, `api.binary()` or `api.text()` (REQ-EXEC-45/AC1) turned into
   * what the transport sends, what the evidence keeps (masked; files as files) and the cURL arguments. Files come from
   * the plan by key only; a forged descriptor is checked the same way.
   */
  const requestBody = async (
    stepId: string,
    body: Record<string, unknown>,
  ): Promise<{
    payload: ApiPayload;
    evidence: unknown;
    curl: string[];
    contentType?: string;
    headers?: Record<string, string>;
    soap?: { version: string; action?: string };
  }> => {
    const invalid = (): Error =>
      new Error("api: invalid request body; use api.multipart, form, binary or text");
    const strings = (v: unknown): Record<string, string> => {
      if (v === undefined) return {};
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid();
      const out: Record<string, string> = {};
      for (const [k, x] of Object.entries(v)) {
        if (typeof x !== "string") throw invalid();
        out[k] = x;
      }
      return out;
    };
    const describe = (f: UiFile) => ({
      name: f.name,
      type: f.type,
      bytes: f.data.byteLength,
      sha256: sha256Hex(f.data),
    });
    const kind = body["__qjBody"];
    if (kind === "multipart") {
      const fields = strings(body["fields"]);
      const keys = strings(body["files"]);
      const files: Record<string, UiFile> = {};
      for (const [field, key] of Object.entries(keys)) {
        const f = await caseFile(key, "api.multipart");
        files[field] = f;
        await fileEvidence(stepId, "upload", f);
      }
      return {
        payload: { kind: "multipart", fields, files },
        evidence: {
          multipart: {
            fields: maskValue(fields),
            files: Object.entries(files).map(([field, f]) => ({ field, ...describe(f) })),
          },
        },
        curl: [
          ...Object.entries(fields).map(([k, v]) => `-F ${shellQuote(`${k}=${masker.maskText(v)}`)}`),
          ...Object.entries(files).map(([k, f]) => `-F ${shellQuote(`${k}=@${f.name};type=${f.type}`)}`),
        ],
      };
    }
    if (kind === "form") {
      const fields = strings(body["fields"]);
      return {
        payload: { kind: "form", fields },
        evidence: { form: maskValue(fields) },
        curl: Object.entries(fields).map(
          ([k, v]) => `--data-urlencode ${shellQuote(`${k}=${masker.maskText(v)}`)}`,
        ),
      };
    }
    if (kind === "binary") {
      if (typeof body["file"] !== "string") throw invalid();
      const f = await caseFile(body["file"], "api.binary");
      await fileEvidence(stepId, "upload", f);
      return {
        payload: { kind: "bytes", data: f.data, type: f.type },
        evidence: { file: describe(f) },
        curl: [`--data-binary ${shellQuote(`@${f.name}`)}`],
        contentType: f.type,
      };
    }
    if (kind === "soap") {
      const xml = body["body"];
      const version = body["version"] ?? "1.1";
      const action = body["action"];
      if (
        typeof xml !== "string" ||
        (version !== "1.1" && version !== "1.2") ||
        (action !== undefined && typeof action !== "string")
      )
        throw invalid();
      const envelope = soapEnvelope(xml, version);
      const contentType =
        version === "1.1"
          ? "text/xml; charset=utf-8"
          : `application/soap+xml; charset=utf-8${action === undefined ? "" : `; action="${action}"`}`;
      return {
        payload: { kind: "bytes", data: new TextEncoder().encode(envelope), type: contentType },
        evidence: {
          soap: { version, ...(action === undefined ? {} : { action }), envelope: masker.maskText(envelope) },
        },
        curl: [`--data-binary ${shellQuote(masker.maskText(envelope))}`],
        contentType,
        ...(version === "1.1" ? { headers: { soapaction: `"${action ?? ""}"` } } : {}),
        soap: { version, ...(action === undefined ? {} : { action }) },
      };
    }
    if (kind === "text") {
      const text = body["text"];
      const type = body["type"] ?? "text/plain";
      if (typeof text !== "string" || typeof type !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/.test(type))
        throw invalid();
      return {
        payload: { kind: "bytes", data: new TextEncoder().encode(text), type },
        evidence: { text: masker.maskText(text), type },
        curl: [`--data-binary ${shellQuote(masker.maskText(text))}`],
        contentType: type,
      };
    }
    throw invalid();
  };

  /** A response that is a file (an attachment, or a type that is not text or JSON), kept as one (REQ-EXEC-45/AC2). */
  const responseFile = (
    pathname: string,
    response: ApiTransportResponse,
  ): { name: string; type: string; data: Uint8Array } | undefined => {
    if (response.bytes === undefined) return undefined;
    const header = (name: string): string =>
      Object.entries(response.headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
    const type = (header("content-type").split(";")[0] ?? "").trim().toLowerCase();
    const disposition = header("content-disposition");
    const attachment = /^\s*attachment/i.test(disposition);
    if (!attachment && (type === "" || isTextType(type) || type.endsWith("+json"))) return undefined;
    const suggested = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    const name = decodeURIComponent(suggested ?? pathname.split("/").filter(Boolean).at(-1) ?? "response");
    return { name, type: type || mimeOf(name), data: response.bytes };
  };

  const limits = options.traffic ?? {
    throttle: () => Promise.resolve(),
    retryBudgetMs: 30_000,
    idempotencyHeader: "Idempotency-Key",
  };
  /** How long this attempt has waited out `Retry-After` so far (REQ-EXEC-54/AC3). */
  let retrySpentMs = 0;
  /** Idempotency keys handed out per step (REQ-EXEC-54/AC4). */
  const keysPerStep = new Map<string, number>();

  const call: CaseRuntime["call"] = async (alias, method, path, body, opts) => {
    if (currentStep === undefined) throw new Error("API calls must run inside step()");
    const stepId = currentStep;
    const planStep = planCase.steps.find((s) => s.id === stepId);
    // REQ-EXEC-54/AC4: a mutating request of a step that asks for it carries a key of its own, the same on retries.
    const keyed = method !== "GET" && planStep?.idempotency_key === true;
    const key = keyed ? (keysPerStep.get(stepId) ?? 0) + 1 : 0;
    if (keyed) keysPerStep.set(stepId, key);
    lastAction.set(stepId, "api");
    const url = new URL(path, options.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    if (!options.allowedOrigins.includes(url.origin))
      throw new Error(`URL ${url.origin} is not in the environment allowlist`);
    const accountHeaders = alias === undefined ? {} : options.accounts[alias];
    if (accountHeaders === undefined) throw new Error(`Unknown account alias '${alias ?? ""}'`);
    // REQ-EXEC-48/AC2: a GraphQL call is a JSON body of its query and variables, marked so the verifier checks it.
    const graphql =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      (body as { __qjBody?: unknown }).__qjBody === "graphql"
        ? (body as { query?: unknown; variables?: unknown })
        : undefined;
    if (
      graphql !== undefined &&
      (typeof graphql.query !== "string" ||
        (graphql.variables !== undefined &&
          (typeof graphql.variables !== "object" ||
            graphql.variables === null ||
            Array.isArray(graphql.variables))))
    )
      throw new Error("api.graphql: the query must be a string and the variables an object");
    if (graphql !== undefined)
      body = {
        query: graphql.query,
        ...(graphql.variables === undefined ? {} : { variables: graphql.variables }),
      };
    const special =
      typeof body === "object" && body !== null && !Array.isArray(body) && "__qjBody" in body
        ? await requestBody(stepId, body)
        : undefined;
    // Account headers win: a spec cannot replace the session of an alias. Multipart and form bodies get their
    // content type (with the boundary) from the transport.
    const headers = {
      ...(special === undefined
        ? { "content-type": "application/json" }
        : special.contentType === undefined
          ? {}
          : { "content-type": special.contentType }),
      // REQ-EXEC-14: a locale run asks the API for that locale; a spec may still set its own header.
      ...(options.locale ? { "accept-language": options.locale } : {}),
      ...special?.headers,
      ...opts.headers,
      ...(keyed
        ? { [limits.idempotencyHeader]: `qj-${caseId}-${stepId}-a${String(options.attempt)}-${String(key)}` }
        : {}),
      ...accountHeaders,
    };
    const started = options.now();
    const sent = (): Promise<ApiTransportResponse> =>
      limits.throttle(url.toString()).then(() =>
        options.transport({
          method,
          url: url.toString(),
          headers,
          ...(special ? { payload: special.payload } : body === undefined ? {} : { body }),
        }),
      );
    // REQ-EXEC-54/AC2: only a request that is safe to repeat is sent again: a GET, or one with an idempotency key.
    const safe = method === "GET" || keyed;
    const retries: Record<string, unknown>[] = [];
    let response: ApiTransportResponse;
    for (;;) {
      try {
        response = await sent();
      } catch (error) {
        if (!safe || retries.filter((r) => "error" in r).length >= 2) throw error;
        retries.push({ error: describeError(error), waitedMs: 0 });
        continue;
      }
      const limit =
        response.status === 429 || response.status === 503
          ? retryAfterMs(response.headers, options.now())
          : undefined;
      // A step that tests the limit itself gets the answer as it came.
      if (limit === undefined || planStep?.expect.status === response.status) break;
      if (!safe)
        throw new Error(
          `rate limited: ${method} ${url.pathname} answered ${String(response.status)}; the request is not safe to repeat (no idempotency key)`,
        );
      if (retrySpentMs + limit > limits.retryBudgetMs)
        throw new Error(
          `rate limited: ${method} ${url.pathname} answered ${String(response.status)} (Retry-After ${String(limit / 1000)} s) after ${String(retrySpentMs / 1000)} s of the ${String(limits.retryBudgetMs / 1000)} s budget`,
        );
      await sleep(limit);
      retrySpentMs += limit;
      retries.push({ status: response.status, waitedMs: limit });
    }
    const durationMs = options.now() - started;
    const file = responseFile(url.pathname, response);
    const parsed = file === undefined ? parseJson(response.text) : undefined;
    let responseBody: unknown;
    if (file) {
      // REQ-EXEC-45/AC2+AC3: the file is evidence on its own, with its hash; the call record points to it.
      const kept = await fileEvidence(stepId, "download", file);
      downloads.set(stepId, { ...file, text: kept.text });
      downloadCount.set(stepId, (downloadCount.get(stepId) ?? 0) + 1);
      responseBody = {
        file: kept.name,
        type: file.type,
        bytes: file.data.byteLength,
        sha256: sha256Hex(file.data),
      };
    } else responseBody = parsed === undefined ? masker.maskText(response.text) : maskValue(parsed);
    const maskedHeaders = masker.maskHeaders(headers);
    const curl = [
      `curl -X ${method} ${shellQuote(masker.maskText(url.toString()))}`,
      ...Object.entries(maskedHeaders).map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`),
      ...(special
        ? special.curl
        : body === undefined
          ? []
          : [`--data ${shellQuote(JSON.stringify(maskValue(body)))}`]),
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
        ...(graphql !== undefined ? { graphql: true } : {}),
        // REQ-EXEC-50/AC2: marked so the verifier checks its fault and its body against the WSDL.
        ...(special?.soap ? { soap: special.soap } : {}),
        request: { headers: maskedHeaders, body: special ? special.evidence : maskValue(body) },
        response: {
          status: response.status,
          headers: masker.maskHeaders(response.headers),
          body: responseBody,
        },
        durationMs,
        ...(retries.length > 0 ? { retries } : {}),
        curl,
      },
    });
    return response;
  };

  /**
   * REQ-EXEC-21/AC7: a page or screen without any element QAJitsu can address (a canvas, a game, an app without
   * accessibility semantics) cannot be tested through its elements; the error says so, so the case is BLOCKED with
   * that reason instead of FAILED.
   */
  const unaddressable = async (d: UiDriver): Promise<boolean> =>
    d.elements !== undefined &&
    !d.url().startsWith("about:") &&
    (await d.elements().catch(() => [undefined])).length === 0;
  /** An action of this attempt found an element: an empty screen later is what the application did, not a canvas. */
  let addressed = false;
  const NO_ELEMENTS =
    "the page or screen shows no element QAJitsu can address (a canvas, a game or an app without accessibility semantics), so it cannot be tested through its elements";
  const uiOp = async (operation: UiOperation): Promise<void> => {
    try {
      await uiAction(operation);
      if ("selector" in operation) addressed = true;
      const page = driver?.currentPage?.();
      actions.push(
        maskValue({
          stepId: currentStep,
          ...operation,
          ...(sessions.size > 1 || activeSession !== "main" ? { session: activeSession } : {}),
          ...(page ? { page: page.index, url: page.url } : {}),
        }) as Record<string, unknown>,
      );
    } catch (error) {
      if (driver && (await unaddressable(driver)))
        throw new Error(`${describeError(error)}; ${NO_ELEMENTS}`, { cause: error });
      // A browser starts on an empty page: say so instead of a bare timeout.
      if (driver && "selector" in operation && driver.url().startsWith("about:blank"))
        throw new Error(
          `${describeError(error)}; no page is open: call ui.goto("<path>") before ui.${operation.op}()`,
          {
            cause: error,
          },
        );
      // REQ-EXEC-64/AC3: a selector that matches several elements says how many and how to narrow it.
      const many = /resolved to (\d+) elements/.exec(describeError(error));
      if (many)
        throw new Error(
          `${describeError(error)}; the selector matches ${many[1] ?? "several"} elements: narrow it with ' >> has-text:<text>', ' >> nth:<n>' or a parent element first (role:row >> ...)`,
          { cause: error },
        );
      // REQ-EXEC-56/AC1: say why an element cannot be reached when the page explains it.
      const reason = driver ? await driver.unreachableReason?.().catch(() => undefined) : undefined;
      if (reason !== undefined) throw new Error(`${describeError(error)}; ${reason}`, { cause: error });
      throw error;
    }
  };
  const uiAction = async (operation: UiOperation): Promise<void> => {
    if (currentStep === undefined) throw new Error("UI actions must run inside step()");
    lastAction.set(currentStep, "ui");
    if (operation.op === "session") {
      // REQ-EXEC-62/AC1: `main` is the case's first session; others are named by an account of the case's data and
      // open logged in as that account, with their own cookies and storage.
      const name = operation.name;
      if (name !== "main") {
        const alias = planCase.data[name];
        if (alias?.startsWith("user:") !== true)
          throw new Error(
            `ui.session('${name.slice(0, 40)}'): name a test account of ${caseId}'s data, e.g. buyer: user:buyer`,
          );
        if (!sessions.has(name)) {
          if (!options.session) throw new Error("This runner cannot open more than one browser session");
          const opened = await options.session(name);
          await opened.useAccount(alias);
          sessions.set(name, opened);
        }
      }
      activeSession = name;
      await browser();
      return;
    }
    const d = await browser();
    // REQ-EXEC-61/AC1: dialogs the action opens are answered as the step says.
    d.setDialogPolicy?.(planCase.steps.find((x) => x.id === currentStep)?.dialog);
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
      case "fillCode": {
        // REQ-EXEC-55/AC3: the code comes from the message the plan expects, read by the parent.
        const selector = assertSelector(operation.selector);
        const stepId = currentStep;
        const filter = planCase.steps.find((x) => x.id === stepId)?.expect.message;
        if (!filter)
          throw new Error(`ui.fillCode(): the plan expects no message in ${stepId} to take a code from`);
        if (!waited.has(stepId)) await inboxWait(stepId);
        const message = waited.get(stepId);
        if (!message) {
          // The application sent no code: the planned check of the message fails here, as verify() would.
          assertions.push({
            stepId,
            field: "message",
            expected: maskValue(filter),
            actual: "(no message arrived in time)",
            pass: false,
          });
          throw new Error(`ui.fillCode(): no message with a code arrived in ${stepId}`);
        }
        const match = new RegExp(filter.code ?? "\\b(\\d{4,8})\\b").exec(
          `${message.subject ?? ""}\n${message.body}`,
        );
        const code = match?.[1] ?? match?.[0];
        if (code === undefined || code === "")
          throw new Error(
            `ui.fillCode(): the message of ${stepId} holds no code matching the plan's pattern`,
          );
        masker.register(code);
        d.registerSecret?.(code);
        // The message was recorded before the code was known: mask the code in that evidence too.
        for (const [i, item] of media.entries())
          if (item.stepId === stepId && item.kind === "message" && typeof item.content === "string")
            media[i] = { ...item, content: masker.maskText(item.content) };
        secretFields.add(selector);
        await d.fill(selector, code);
        return;
      }
      case "fillSecret": {
        // REQ-EXEC-67/AC3: the value is resolved here, masked everywhere, and never handed back to the spec.
        const selector = assertSelector(operation.selector);
        // The sandbox schema checks this too; an in-process caller is held to the same rule.
        const field: string = operation.field;
        if (field !== "password" && field !== "username" && field !== "totp")
          throw new Error('ui.fillSecret() types "password", "username" or "totp" of an account');
        if (!Object.values(planCase.data).includes(operation.alias))
          throw new Error(
            `ui.fillSecret(): '${operation.alias.slice(0, 40)}' is not an account of ${caseId} in the plan`,
          );
        const value = options.credential?.(operation.alias, operation.field);
        if (value === undefined || value === "")
          throw new Error(
            `ui.fillSecret(): no ${operation.field} for ${operation.alias} in this environment`,
          );
        masker.register(value);
        d.registerSecret?.(value);
        secretFields.add(selector);
        await d.fill(selector, value);
        return;
      }
      case "select":
        await d.select(assertSelector(operation.selector), operation.value);
        return;
      case "press":
        await d.press(assertSelector(operation.selector), operation.value);
        return;
      case "waitFor":
        await d.waitFor(assertSelector(operation.selector), operation.state);
        return;
      case "hover":
      case "dblclick":
      case "rightclick":
        await need(
          d,
          "pointer",
          `ui.${operation.op === "rightclick" ? "rightClick" : operation.op}()`,
        )(assertSelector(operation.selector), operation.op);
        return;
      case "dragTo":
        await need(
          d,
          "dragTo",
          "ui.dragTo()",
        )(assertSelector(operation.selector), assertSelector(operation.target));
        return;
      case "dragBy":
        await need(d, "dragBy", "ui.dragBy()")(
          assertSelector(operation.selector),
          operation.dx,
          operation.dy,
        );
        return;
      case "keys":
        await need(d, "keys", "ui.keys()")(operation.value);
        return;
      case "scrollTo":
        await need(d, "scrollTo", "ui.scrollTo()")(assertSelector(operation.selector));
        return;
      case "scrollBy":
        await need(d, "scrollBy", "ui.scrollBy()")(operation.dx, operation.dy);
        return;
      case "scrollUntil": {
        const limit = planCase.steps.find((x) => x.id === currentStep)?.scroll_limit ?? 20;
        const r = await need(d, "scrollUntil", "ui.scrollUntil()")(assertSelector(operation.selector), limit);
        // Not found is not an error of the run: the step's planned check of the element decides (REQ-EXEC-40/AC3).
        actions.push({ stepId: currentStep, op: "scrollUntil.result", ...r, limit });
        return;
      }
      case "upload": {
        if (operation.files.length === 0)
          throw new Error("ui.upload() needs at least one file key of the plan");
        const files = await Promise.all(operation.files.map((k) => caseFile(k)));
        await need(d, "upload", "ui.upload()")(assertSelector(operation.selector), files);
        for (const f of files) await fileEvidence(currentStep, "upload", f);
        return;
      }
      case "download": {
        const got = await need(d, "download", "ui.download()")(assertSelector(operation.selector), waitMs);
        const type = mimeOf(got.name);
        const { text } = await fileEvidence(currentStep, "download", {
          name: got.name,
          type,
          data: got.data,
        });
        downloads.set(currentStep, { name: got.name, type, data: got.data, text });
        downloadCount.set(currentStep, (downloadCount.get(currentStep) ?? 0) + 1);
        return;
      }
      case "switchPage":
        await need(d, "switchPage", "ui.switchToNewPage()")(operation.to, waitMs);
        return;
      case "closePage":
        await need(d, "closePage", "ui.closePage()")();
        return;
      case "advanceTime":
        if (!Number.isInteger(operation.seconds) || operation.seconds < 1 || operation.seconds > 604_800)
          throw new Error("ui.advanceTime() takes whole seconds from 1 to 604800 (7 days)");
        await need(d, "advanceTime", "ui.advanceTime()")(operation.seconds * 1000);
        return;
      case "gesture": {
        // REQ-EXEC-41 + REQ-EXEC-63/AC2: checked here, performed by the driver, drawn on the step's screenshot.
        const g = operation.gesture;
        checkGesture(g);
        if ("selector" in g && g.selector !== undefined) assertSelector(g.selector);
        const done = await need(d, "gesture", `ui.${g.kind}()`)(g);
        const list = gesturesOf.get(currentStep) ?? [];
        list.push({ kind: g.kind, fingers: done.fingers });
        gesturesOf.set(currentStep, list);
        return;
      }
      case "setOffline":
        // REQ-EXEC-65/AC2: the browser's whole network goes off or comes back; the page sees it as a real outage.
        if (typeof operation.offline !== "boolean")
          throw new Error("ui.setOffline() takes true (offline) or false (back online)");
        await need(d, "setOffline", "ui.setOffline()")(operation.offline);
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
  /** Differing regions of a failed visual check per step, for the annotated screenshot (REQ-EVD-08/AC3). */
  const visualFailures = new Map<string, { regions: readonly ScreenBox[]; baseline: Uint8Array }>();

  /**
   * Marks where a failed step went wrong (REQ-EVD-08): a copy of the step screenshot with a numbered red box around
   * each element whose assertion failed and each region that differs from the visual baseline, and a JSON with the
   * field, expected and actual value of every mark. A missing element gets no box, only a note; with a visual
   * baseline the baseline copy shows the changed regions (AC2). The original screenshot is never changed and nothing
   * here changes an assertion or a status (AC4).
   */
  /** REQ-EXEC-41/AC3: each gesture's path on a copy of the step's screenshot, its points numbered in order. */
  const drawGestures = async (stepId: string, png: Uint8Array): Promise<void> => {
    const done = gesturesOf.get(stepId);
    if (!done || done.length === 0) return;
    media.push({
      stepId,
      kind: "log",
      name: `${stepId}-gestures.json`,
      content: `${JSON.stringify(done, null, 2)}\n`,
    });
    if (!options.annotate) return;
    const marks: ScreenMark[] = [];
    for (const g of done)
      for (const finger of g.fingers)
        for (const p of finger)
          marks.push({ n: marks.length + 1, box: { x: p.x - 10, y: p.y - 10, width: 20, height: 20 } });
    try {
      media.push({
        stepId,
        kind: "screenshot",
        name: `${stepId}-gestures.png`,
        content: await options.annotate(png, marks),
      });
    } catch {
      // The plain screenshot and the path in the JSON stay.
    }
  };
  const annotateStep = async (stepId: string, png: Uint8Array): Promise<void> => {
    if (!options.annotate || !driver) return;
    const elementFails = assertions.filter(
      (a) => a.stepId === stepId && !a.pass && a.field.startsWith("elements."),
    );
    const visualFail = visualFailures.get(stepId);
    if (elementFails.length === 0 && !visualFail) return;
    const marks: ScreenMark[] = [];
    const notes: Record<string, unknown>[] = [];
    const size = pngDimensions(png);
    // A box that lies outside the screenshot (e.g. a long page scrolled elsewhere) cannot be drawn; it is named.
    const visible = (b: ScreenBox): boolean =>
      size === undefined ||
      (b.x < size.width && b.y < size.height && b.x + b.width > 0 && b.y + b.height > 0);
    for (const a of elementFails) {
      const n = notes.length + 1;
      const selector = a.field.slice("elements.".length).split(".").slice(0, -1).join(".");
      let box: ScreenBox | undefined;
      try {
        box = await driver.bounds?.(assertSelector(selector));
      } catch {
        box = undefined;
      }
      if (box && visible(box)) marks.push({ n, box });
      notes.push({
        n,
        field: a.field,
        expected: a.expected,
        actual: a.actual,
        ...(box
          ? { box, ...(visible(box) ? {} : { note: "element is outside the visible screenshot" }) }
          : { note: "element not found on the screen" }),
      });
    }
    const visualMarks: ScreenMark[] = [];
    for (const box of visualFail?.regions ?? []) {
      const n = notes.length + 1;
      visualMarks.push({ n, box });
      marks.push({ n, box });
      notes.push({ n, field: "visual", note: "differs from the baseline", box });
    }
    try {
      if (marks.length > 0)
        media.push({
          stepId,
          kind: "screenshot",
          name: `${stepId}-annotated.png`,
          // A copy: the drawing can never change the original screenshot evidence (AC4).
          content: await options.annotate(png.slice(), marks),
        });
      if (
        visualFail &&
        visualMarks.length > 0 &&
        notes.some((x) => x["note"] === "element not found on the screen")
      )
        media.push({
          stepId,
          kind: "screenshot",
          name: `${stepId}-annotated-baseline.png`,
          content: await options.annotate(visualFail.baseline.slice(), visualMarks),
        });
      media.push({
        stepId,
        kind: "other",
        name: `${stepId}-annotations.json`,
        content: `${JSON.stringify({ step: stepId, marks: notes }, null, 2)}\n`,
      });
    } catch {
      // A drawing that fails leaves the evidence as it is; it never affects the attempt.
    }
  };

  const verifyVisual = async (stepId: string, field: string): Promise<void> => {
    const spec = planCase.steps.find((x) => x.id === stepId)?.expect.visual;
    if (!spec)
      throw new Error(`verify('${stepId}', 'visual'): the plan has no visual expectation in ${stepId}`);
    if (!driver) throw new Error(`verify('${stepId}', 'visual') needs the browser or device to be open`);
    if (!options.visual) throw new Error("This run has no visual comparison (REQ-EXEC-12)");
    const visual = options.visual;
    const key = `${caseId}/${stepId}-${spec.name}.${visual.variant}`;
    const threshold = spec.threshold ?? visual.threshold;
    const actual =
      spec.element === undefined
        ? await driver.screenshot(false, [
            ...(spec.mask ?? []).map((m) => assertSelector(m)),
            ...secretFields,
          ])
        : await need(
            driver,
            "elementScreenshot",
            "a visual check of an element",
          )(assertSelector(spec.element));
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
    // REQ-EVD-08/AC3: the regions of a difference above the threshold are marked on the annotated screenshot.
    if (ratio > threshold) visualFailures.set(stepId, { regions: result.regions ?? [], baseline });
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
    if (kind === "download") {
      // REQ-EXEC-38/AC2+AC4: checked by code against the file the step downloaded; none is a failure, never a pass.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      const got = downloads.get(stepId);
      if (!got) {
        assertions.push({
          stepId,
          field,
          expected: maskValue(expected),
          actual: "(no download in this step)",
          pass: false,
        });
        return;
      }
      const [part, ...more] = rest;
      const needText = (): string => {
        if (got.text === undefined)
          throw new Error(`verify('${stepId}', '${field}'): the content of ${got.name} cannot be read`);
        return got.text;
      };
      if (part === "count") record(expected, downloadCount.get(stepId) ?? 0);
      else if (part === "name") record(expected, got.name);
      else if (part === "sha256") record(expected, sha256Hex(got.data));
      else if (part === "type") {
        const ext = /\.([A-Za-z0-9]+)$/.exec(got.name)?.[1]?.toLowerCase();
        record(expected, expected === ext ? ext : got.type);
      } else if (part === "size") {
        const range = expected as { min_bytes?: number; max_bytes?: number };
        const n = got.data.byteLength;
        assertions.push({
          stepId,
          field,
          expected: maskValue(expected),
          actual: n,
          pass:
            (range.min_bytes === undefined || n >= range.min_bytes) &&
            (range.max_bytes === undefined || n <= range.max_bytes),
        });
      } else if (part === "rows") record(expected, csvRows(needText()));
      else if (part === "texts")
        record(
          expected,
          typeof expected === "string" && needText().includes(expected) ? expected : "(text not in the file)",
        );
      else if (part === "fields") {
        const content = needText();
        let parsed: unknown;
        try {
          parsed = JSON.parse(content) as unknown;
        } catch {
          throw new Error(`verify('${stepId}', '${field}'): ${got.name} is not JSON`);
        }
        record(expected, at(parsed, more.join(".")));
      }
      return;
    }
    if (kind === "dialog") {
      // REQ-EXEC-61/AC1: the last dialog of the step, read by the parent; none shown is a failure, never a pass.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      collectDialogs(stepId);
      const last = dialogsOf.get(stepId)?.at(-1);
      const part = rest[0] === "type" ? "type" : "message";
      const actual = last?.[part];
      assertions.push({
        stepId,
        field,
        expected: maskValue(expected),
        actual: actual === undefined ? "(no dialog in this step)" : maskValue(actual),
        pass:
          actual !== undefined &&
          (part === "type" ? actual === expected : typeof expected === "string" && actual.includes(expected)),
      });
      return;
    }
    if (kind === "websocket") {
      // REQ-EXEC-47/AC3: a frame of the page's WebSockets in this step, recorded by the parent; none in time fails.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      if (!driver)
        throw new Error(`verify('${stepId}', '${field}') needs an open page: call ui.goto() first`);
      const direction = rest[0] === "sent" ? "sent" : "received";
      const url = planCase.steps.find((x) => x.id === stepId)?.expect.websocket?.url;
      const found = await need(driver, "socketFrame", `verify('${stepId}', 'websocket.*')`)(
        direction,
        String(expected),
        url,
        waitMs,
      );
      record(expected, found === undefined ? `(no ${direction} WebSocket message contains it)` : expected);
      return;
    }
    if (kind === "manifest") {
      // REQ-EXEC-65/AC3: the page's manifest and its service worker, read by the parent; no manifest never passes.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      if (!driver)
        throw new Error(`verify('${stepId}', '${field}') needs an open page: call ui.goto() first`);
      const part = rest[0] ?? "";
      // Blocked service workers never control a page: that would fail the check for a reason of the plan.
      if (part === "controlled" && planCase.browser?.service_workers !== true)
        throw new Error(
          `verify('${stepId}', '${field}'): the case blocks service workers; allow them with "browser": {"service_workers": true}`,
        );
      const read = await need(driver, "manifest", `verify('${stepId}', 'manifest.*')`)();
      let actual: unknown;
      if (part === "controlled") actual = read.controlled;
      else if (!read.manifest) actual = "(the page links no readable web app manifest)";
      else if (part === "icons")
        actual = Array.isArray(read.manifest["icons"]) ? read.manifest["icons"].length : 0;
      else actual = read.manifest[part];
      record(expected, actual);
      return;
    }
    if (kind === "state") {
      // REQ-EXEC-56/AC2: what the application exposes for tests, read by the parent from the page.
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      if (!driver)
        throw new Error(`verify('${stepId}', '${field}') needs an open page: call ui.goto() first`);
      const hook = options.testStateHook ?? "__QA_STATE__";
      const read = await need(driver, "testState", `verify('${stepId}', 'state.*')`)(hook, rest.join("."));
      if (!read.hook)
        throw new Error(`verify('${stepId}', '${field}'): the page has no test hook window.${hook}`);
      record(expected, read.value);
      return;
    }
    if (kind === "elements") {
      // elements.<selector>.<property>: read from the live page by the parent.
      const property = rest.at(-1) as UiProperty | undefined;
      if (property === undefined || !PROPERTIES.includes(property) || rest.length < 2) {
        throw new Error(
          `verify('${stepId}', '${field}'): use elements.<selector>.<visible|enabled|checked|text|value|in_viewport>`,
        );
      }
      const expected = expectationOf(planCase, stepId, field, `${caseId}.${stepId}.${field}`);
      // A native app is open from the start of the case; a browser has no page until ui.goto().
      if (!driver && planCase.type === "mobile") await browser();
      if (!driver)
        throw new Error(`verify('${stepId}', '${field}') needs an open page: call ui.goto() first`);
      const actual = await driver.property(assertSelector(rest.slice(0, -1).join(".")), property);
      if (!addressed && !isDeepStrictEqual(actual, expected) && (await unaddressable(driver)))
        throw new Error(`verify('${stepId}', '${field}'): ${NO_ELEMENTS}`);
      record(expected, actual);
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
    if (kind === "messages") {
      // REQ-EXEC-47/AC1+AC2+AC5: the check waits for the planned message itself, so a spec cannot look too early; a
      // message that never comes fails the step, with the close code and reason when the stream ended first.
      const stream = streams.last(stepId);
      if (!stream)
        throw new Error(
          `verify('${stepId}', '${field}') needs a stream opened in the step: api.websocket() or api.events()`,
        );
      const timeoutMs = (planCase.steps.find((x) => x.id === stepId)?.stream?.timeout_s ?? 10) * 1000;
      const ended = (): string =>
        stream.closed && stream.closed.code !== 1000
          ? ` (the stream closed with ${String(stream.closed.code)}${stream.closed.reason ? ` ${stream.closed.reason}` : ""})`
          : "";
      if (rest[0] === "count") {
        await streams.waitFor(stream, () => false, timeoutMs);
        record(expected, stream.messages.length);
        return;
      }
      const n = Number(rest[0]);
      const came = await streams.waitFor(stream, () => stream.messages.length > n, timeoutMs);
      record(
        expected,
        came
          ? at(stream.messages[n], rest.slice(1).join("."))
          : `(no message ${String(n)} within ${String(timeoutMs / 1000)} s${ended()})`,
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
    else if (kind === "xml") {
      // REQ-EXEC-50/AC3: text from XML is read as the plan's type when it is that type written as text.
      const raw = xmlValue(last.text, rest.join("."));
      actual =
        typeof expected === "number" &&
        typeof raw === "string" &&
        raw.trim() !== "" &&
        !Number.isNaN(Number(raw))
          ? Number(raw)
          : typeof expected === "boolean" && (raw === "true" || raw === "false")
            ? raw === "true"
            : raw;
    } else if (kind === "texts")
      actual =
        typeof expected === "string" && last.text.includes(expected)
          ? expected
          : "(text not found in the response)";
    else
      throw new Error(
        `verify('${stepId}', '${field}'): only status, fields.<key>, texts.<n>, elements.<selector>.<property>, download.*, state.*, manifest.*, websocket.*, message and visual can be verified`,
      );
    record(expected, actual);
  };

  /** Body descriptors (REQ-EXEC-45/AC1): plain data, resolved and checked when the call is made. */
  const bodies: Pick<ApiClient, "multipart" | "form" | "binary" | "text"> = {
    multipart: (parts) => ({
      __qjBody: "multipart",
      ...(parts.fields ? { fields: parts.fields } : {}),
      ...(parts.files ? { files: parts.files } : {}),
    }),
    form: (fields) => ({ __qjBody: "form", fields }),
    binary: (file) => ({ __qjBody: "binary", file }),
    text: (text, type) => ({ __qjBody: "text", text, ...(type === undefined ? {} : { type }) }),
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
      return {
        status: r.status,
        headers: r.headers,
        text: r.text,
        json: (p) => at(parsed, p),
        xml: (x) => Promise.resolve(xmlValue(r.text, x)),
      };
    };
    return {
      get: (path, o) => send("GET", path, undefined, o),
      post: (path, body, o) => send("POST", path, body, o),
      put: (path, body, o) => send("PUT", path, body, o),
      patch: (path, body, o) => send("PATCH", path, body, o),
      delete: (path, o) => send("DELETE", path, undefined, o),
      soap: (path, body, o) =>
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
      graphql: (query, variables, o) =>
        send(
          "POST",
          o?.path ?? "/graphql",
          { __qjBody: "graphql", query, ...(variables ? { variables } : {}) },
          o,
        ),
      as: (a) => client(a),
      websocket: (path, o) => openStream(alias, "websocket", path, o?.protocols),
      events: (path) => openStream(alias, "sse", path),
      ...bodies,
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
      fillSecret: (selector, alias, field) => uiOp({ op: "fillSecret", selector, alias, field }),
      fillCode: (selector) => uiOp({ op: "fillCode", selector }),
      session: (name) => uiOp({ op: "session", name }),
      tap: (selector) => uiOp({ op: "gesture", gesture: { kind: "tap", selector } }),
      doubleTap: (selector) => uiOp({ op: "gesture", gesture: { kind: "doubleTap", selector } }),
      longPress: (selector, seconds = 1) =>
        uiOp({ op: "gesture", gesture: { kind: "longPress", selector, seconds } }),
      swipe: (target, direction, opts = {}) =>
        uiOp({
          op: "gesture",
          gesture: {
            kind: "swipe",
            ...(target === "screen" ? {} : { selector: target }),
            direction,
            distance: opts.distance ?? 0.6,
            speed: opts.speed ?? "normal",
          },
        }),
      pinch: (target, direction, scale = 0.6) =>
        uiOp({
          op: "gesture",
          gesture: { kind: "pinch", ...(target === "screen" ? {} : { selector: target }), direction, scale },
        }),
      pullToRefresh: () => uiOp({ op: "gesture", gesture: { kind: "pullToRefresh" } }),
      check: (selector) => uiOp({ op: "check", selector }),
      uncheck: (selector) => uiOp({ op: "uncheck", selector }),
      select: (selector, value) => uiOp({ op: "select", selector, value }),
      press: (selector, value) => uiOp({ op: "press", selector, value }),
      waitFor: (selector, state = "visible") => uiOp({ op: "waitFor", selector, state }),
      back: () => uiOp({ op: "back" }),
      as: (alias) => uiOp({ op: "as", alias }),
      hover: (selector) => uiOp({ op: "hover", selector }),
      dblclick: (selector) => uiOp({ op: "dblclick", selector }),
      rightClick: (selector) => uiOp({ op: "rightclick", selector }),
      dragTo: (selector, target) => uiOp({ op: "dragTo", selector, target }),
      dragBy: (selector, dx, dy) => uiOp({ op: "dragBy", selector, dx, dy }),
      keys: (value) => uiOp({ op: "keys", value }),
      scrollTo: (selector) => uiOp({ op: "scrollTo", selector }),
      scrollBy: (dx, dy) => uiOp({ op: "scrollBy", dx, dy }),
      scrollUntil: (selector) => uiOp({ op: "scrollUntil", selector }),
      upload: (selector, ...files) => uiOp({ op: "upload", selector, files }),
      download: (selector) => uiOp({ op: "download", selector }),
      switchToNewPage: () => uiOp({ op: "switchPage", to: "new" }),
      switchToOpener: () => uiOp({ op: "switchPage", to: "opener" }),
      closePage: () => uiOp({ op: "closePage" }),
      advanceTime: (seconds) => uiOp({ op: "advanceTime", seconds }),
      setOffline: (offline) => uiOp({ op: "setOffline", offline }),
    },
    step: async (stepId, fn) => {
      beginStep(stepId);
      try {
        // REQ-EXEC-46: a step with a planned wait repeats its actions and checks until they hold or time is up.
        for (;;) {
          await fn();
          await pending;
          const next = pollRound(stepId);
          if (!next.again) break;
          await sleep(next.delayMs);
        }
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
    data: {
      get: (name) => {
        const record = Object.hasOwn(options.testData ?? {}, name) ? options.testData?.[name] : undefined;
        if (record === undefined)
          throw new Error(`data.get('${name.slice(0, 40)}'): no test data of ${caseId} has this name`);
        return record;
      },
    },
  };

  return {
    context,
    beginStep,
    pollRound,
    endStep,
    call,
    openStream: async (alias, kind, path, protocols) => {
      streamHandles.push(await openStream(alias, kind, path, protocols));
      return streamHandles.length - 1;
    },
    streamOp: (handle, op, data) => {
      const stream = streamHandles[handle];
      if (!stream) return Promise.reject(new Error(`no stream ${String(handle)}`));
      return op === "send" ? stream.send(data) : op === "messages" ? stream.messages() : stream.close();
    },
    uiOp,
    verify,
    inboxAddress,
    inboxWait,
    finish: async (error) => {
      if (error !== undefined) failure = masker.maskText(describeError(error));
      // REQ-EXEC-11/AC5: a manual step the spec never ran cannot be skipped into a pass.
      for (const id of manualSteps.keys())
        if (!steps.some((s) => s.id === id)) failure ??= `manual step ${id} was not performed`;
      // REQ-EXEC-47/AC4: every frame of every stream, masked.
      const evidence: EvidenceItem[] = [...media, ...streams.finish()];
      // REQ-EXEC-39/AC2: which page each action went to, when the case used more than one or new web actions.
      if (
        actions.some((a) => a["page"] !== undefined && a["page"] !== 0) ||
        // REQ-EXEC-62/AC2: which session every action went to.
        actions.some((a) => a["session"] !== undefined) ||
        actions.some((a) => a["op"] === "scrollUntil.result")
      )
        evidence.push({
          stepId: "case",
          kind: "log",
          name: "ui-actions.json",
          content: `${JSON.stringify(actions, null, 2)}\n`,
        });
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
            content: await driver.screenshot(true, [...secretFields]),
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
        // REQ-EXEC-22/AC4: the elements on the page or screen at the failure, for the healer and the reviewer.
        const elements = await driver.elements?.().catch(() => undefined);
        if (elements !== undefined)
          evidence.push({
            stepId: "case",
            kind: "dom",
            name: "failure-elements.json",
            content: masker.maskText(`${JSON.stringify(elements, null, 2)}\n`),
          });
      }
      return {
        caseId,
        attempt,
        outcome,
        ...(failure === undefined ? {} : { error: failure }),
        steps,
        assertions,
        evidence,
        // REQ-EVD-09/AC2: the application's endpoints the page reached, for the coverage of the change.
        ...(traffic.length > 0
          ? { requests: maskValue(reachedEndpoints(traffic)) as ReachedEndpoint[] }
          : {}),
      };
    },
  };
}
