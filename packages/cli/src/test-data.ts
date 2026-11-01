import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  ConfigError,
  QajitsuError,
  type ProjectConfig,
  type TestDataProvider,
  type TestDataRecord,
} from "@qajitsu/core";

type TestDataConfig = NonNullable<ProjectConfig["test_data"]>;

/** Runs the data hook with a JSON request on stdin and returns its stdout (REQ-EXEC-53/AC1). */
export type DataHookRunner = (
  script: string,
  request: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<string>;

/** The data hook as a separate Node process: an argument array, no shell, a minimal environment and a time limit. */
export const runDataHook: DataHookRunner = (script, request, env, timeoutMs) =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) done(out);
      else fail(new Error(`data hook exited with ${String(code)}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(JSON.stringify(request));
  });

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      value,
    );

/**
 * The test data of a run (REQ-EXEC-53): per kind through the application's API as configured in `test_data.kinds`, or
 * the project's data hook for the other kinds. Every request goes to an allowed origin only (invariant 10), as an
 * account alias whose headers the run's login provides; every record carries the marker in `marker_field`.
 *
 * @param options - The project's `test_data`, the environment's base URL and allowed origins, the account login, and
 *   the data hook's folder and runner.
 */
export function createTestDataProvider(options: {
  readonly config: TestDataConfig;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  /** Request headers of an account alias for one call; no alias, no headers. */
  readonly headersFor: (alias: string | undefined) => Promise<Readonly<Record<string, string>>>;
  readonly qaDir: string;
  readonly runHook?: DataHookRunner;
}): TestDataProvider {
  const { config } = options;
  const runHook = options.runHook ?? runDataHook;
  const url = (path: string): URL => {
    const target = new URL(path, options.baseUrl);
    if (!options.allowedOrigins.includes(target.origin))
      throw new ConfigError(
        "TEST_DATA_ORIGIN_DENIED",
        `test data: ${target.origin} is not an allowed origin`,
        {},
      );
    return target;
  };
  const send = async (request: string, alias: string | undefined, body?: unknown): Promise<unknown> => {
    const [method = "", path = "/"] = request.split(" ");
    const res = await options.fetch(url(path), {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(await options.headersFor(alias)),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
    const text = await res.text();
    if (!res.ok && !(method === "DELETE" && res.status === 404))
      throw new QajitsuError(
        "TEST_DATA_REQUEST_FAILED",
        `${method} ${path} answered ${String(res.status)}: ${text.slice(0, 200)}`,
        {
          status: res.status,
        },
      );
    try {
      return text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return text;
    }
  };
  const hook = async (request: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    if (config.hook === undefined)
      throw new ConfigError(
        "TEST_DATA_KIND_UNKNOWN",
        `test data of kind ${typeof request["kind"] === "string" ? request["kind"] : "?"} has no API in test_data.kinds and the project has no test_data.hook`,
        {},
      );
    const out = await runHook(
      resolve(options.qaDir, config.hook),
      request,
      {
        BASE_URL: options.baseUrl,
        QAJITSU_MARKER:
          [request["marker"], request["prefix"]].find((v): v is string => typeof v === "string") ?? "",
      },
      config.timeout_s * 1000,
    );
    const last = out.trim().split("\n").at(-1) ?? "";
    try {
      const parsed = JSON.parse(last) as unknown;
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new QajitsuError("TEST_DATA_HOOK_ANSWER", "the data hook's last line is not a JSON object", {});
    }
  };
  return {
    create: async ({ name, kind, with: fields, marker }) => {
      const body = { ...fields, [config.marker_field]: marker };
      const api = config.kinds[kind];
      let answer: unknown;
      if (api) answer = await send(api.create.request, api.create.as, body);
      else answer = await hook({ action: "create", name, kind, with: body, marker });
      const record = (answer !== null && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
      const id = api ? at(record, api.create.id) : (record["id"] ?? at(record, "record.id"));
      if (typeof id !== "string" && typeof id !== "number")
        throw new QajitsuError(
          "TEST_DATA_NO_ID",
          `the answer for ${name} has no id${api ? ` at ${api.create.id}` : ""}`,
          {},
        );
      const recordFields =
        !api && typeof record["record"] === "object" && record["record"] !== null
          ? (record["record"] as Record<string, unknown>)
          : record;
      return { name, kind, id: String(id), record: recordFields } satisfies TestDataRecord;
    },
    remove: async (record, marker) => {
      const api = config.kinds[record.kind];
      if (api?.remove)
        await send(api.remove.request.replace("{id}", encodeURIComponent(record.id)), api.remove.as);
      else if (api)
        throw new ConfigError(
          "TEST_DATA_NO_REMOVE",
          `test data of kind ${record.kind} has no remove request`,
          {},
        );
      else await hook({ action: "remove", name: record.name, kind: record.kind, id: record.id, marker });
    },
    cleanup: async (prefix) => {
      if (config.cleanup) {
        const answer = await send(
          config.cleanup.request.replace("{marker}", encodeURIComponent(prefix)),
          config.cleanup.as,
        );
        const n = at(answer, "removed");
        return typeof n === "number" ? n : undefined;
      }
      const answer = await hook({ action: "cleanup", prefix });
      return typeof answer["removed"] === "number" ? answer["removed"] : undefined;
    },
  };
}

/** The marker of a run's test data (REQ-EXEC-53/AC2): `qj-<ticket>-<run id>`; attempts add `-<case>-a<n>`. */
export const testDataMarker = (ticket: string, runId: string): string => `qj-${ticket}-${runId}`;
