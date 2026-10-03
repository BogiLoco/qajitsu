import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { CaseResultFileSchema, PlanSchema, createEventLog, parseEventLines } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { executeAttempt, type AttemptInput } from "./attempt.js";
import { runCases } from "./run-cases.js";
import type { AttemptExecutor } from "./sandbox.js";
import { createPlaywrightTransport } from "./transport.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(
    readFileSync(new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
  ),
});
const specDir = fileURLToPath(new URL("../../../../fixtures/specs/demo-1/", import.meta.url));
const PASSWORD = "fictional-demo-password";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const inProcess: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};

const setup = async (flag?: string) => {
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) },
  });
  const run = await mkdtemp(join(tmpdir(), "qj-runner-"));
  cleanups.push(
    () => shop.close(),
    () => rm(run, { recursive: true, force: true }),
  );
  const tokens: string[] = [];
  const login = async () => {
    const res = (await (
      await fetch(`${shop.url}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "standard", password: PASSWORD }),
      })
    ).json()) as { token: string };
    tokens.push(res.token);
    return {
      accounts: { "user:standard": { authorization: `Bearer ${res.token}` } },
      secrets: [res.token, PASSWORD],
    };
  };
  const lines: string[] = [];
  return {
    shop,
    run,
    lines,
    tokens,
    options: {
      plan,
      evidence: createLocalEvidenceStore(join(run, "evidence")),
      resultsDir: join(run, "results"),
      baseUrl: shop.url,
      allowedOrigins: [shop.url],
      login,
      events: createEventLog({
        ticket: "DEMO-1",
        run: "r",
        write: (l) => lines.push(l),
        now: () => new Date(0),
        mask: (v) => v,
      }),
      now: () => new Date(0),
    },
  };
};

describe("API runner (REQ-EXEC-04, REQ-EXEC-08, REQ-EVD-01)", () => {
  it("REQ-EXEC-04/AC1 + REQ-EVD-01/AC1+AC2: runs specs on Playwright APIRequestContext and stores masked evidence per call", async () => {
    const { run, tokens, options, lines } = await setup();
    const specs = new Map([
      ["TC-01", join(specDir, "TC-01.spec.ts")],
      ["TC-02", join(specDir, "TC-02.spec.ts")],
    ]);
    const results = await runCases({ ...options, specs, executor: inProcess });
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    expect(results.get("TC-02")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    const file = CaseResultFileSchema.parse(
      JSON.parse(await readFile(join(run, "results", "TC-01.json"), "utf8")),
    );
    expect(file.attempts[0]?.evidence).toEqual(["TC-01/attempt-1/S1-01.json", "TC-01/attempt-1/S1-02.json"]);
    const call = await readFile(join(run, "evidence", "TC-01/attempt-1/S1-02.json"), "utf8");
    expect(call).toContain('"total": 1.01');
    expect(call).toContain("curl -X GET");
    expect(tokens).toHaveLength(2);
    for (const token of tokens) expect(call).not.toContain(token);
    const manifest = JSON.parse(await readFile(join(run, "evidence", "manifest.json"), "utf8")) as unknown[];
    expect(manifest).toHaveLength(5);
    expect(parseEventLines(lines.join("")).events.map((e) => e.event)).toContain("verify");
  });

  it("REQ-NFR-04: the seeded rounding bug makes the assertion fail; every attempt is kept (REQ-EXEC-08/AC3)", async () => {
    const { options } = await setup("BUG_CART_TOTAL_ROUNDING");
    const results = await runCases({
      ...options,
      specs: new Map([["TC-01", join(specDir, "TC-01.spec.ts")]]),
      executor: inProcess,
    });
    const attempts = results.get("TC-01")?.attempts ?? [];
    expect(attempts.map((a) => a.outcome)).toEqual(["failed", "failed"]);
    expect(attempts[0]?.assertions.find((a) => a.field === "fields.total")).toMatchObject({
      expected: 1.01,
      actual: 1.02,
      pass: false,
    });
    expect(results.get("TC-02")?.attempts).toEqual([expect.objectContaining({ outcome: "skipped" })]);
  });

  it("REQ-EXEC-08/AC1+AC2: a retry that passes is recorded as a second attempt (FLAKY is decided by the verifier)", async () => {
    const { options } = await setup();
    let calls = 0;
    const flaky: AttemptExecutor = async (input) => {
      calls += 1;
      const record = await inProcess(input);
      return calls === 1
        ? { ...record, outcome: "failed", assertions: record.assertions.map((a) => ({ ...a, pass: false })) }
        : record;
    };
    const results = await runCases({
      ...options,
      specs: new Map([["TC-01", join(specDir, "TC-01.spec.ts")]]),
      executor: flaky,
      retries: 1,
    });
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["failed", "passed"]);
  });

  it("a spec that exports the wrong case or no run function errors instead of passing", async () => {
    const { run, options } = await setup();
    const wrong = join(run, "TC-01.spec.ts");
    await writeFile(wrong, 'export const caseId = "TC-02";\nexport async function run() {}\n');
    const input: AttemptInput = {
      ...options,
      ...(await options.login()),
      specFile: wrong,
      caseId: "TC-01",
      attempt: 1,
      timeoutMs: 1000,
    };
    expect(await inProcess(input)).toMatchObject({
      outcome: "error",
      error: expect.stringContaining("expected TC-01") as unknown,
    });
    const norun = join(run, "TC-02.spec.ts");
    await writeFile(norun, 'export const caseId = "TC-02";\n');
    expect(await inProcess({ ...input, specFile: norun, caseId: "TC-02" })).toMatchObject({
      outcome: "error",
    });
    const hang = join(run, "hang.spec.ts");
    await writeFile(
      hang,
      'export const caseId = "TC-01";\nexport function run() { return new Promise(() => {}); }\n',
    );
    expect(await inProcess({ ...input, specFile: hang, timeoutMs: 50 })).toMatchObject({
      outcome: "error",
      error: expect.stringContaining("timed out") as unknown,
    });
  });

  it("invariant 2: results are never overwritten", async () => {
    const { options } = await setup();
    const specs = new Map([["TC-01", join(specDir, "TC-01.spec.ts")]]);
    await runCases({ ...options, specs, executor: inProcess });
    await expect(runCases({ ...options, specs, executor: inProcess })).rejects.toThrow();
  });

  it("a failed login makes the attempt an error (BLOCKED), never a pass", async () => {
    const { options } = await setup();
    const results = await runCases({
      ...options,
      login: () => Promise.reject(new Error("401")),
      specs: new Map([["TC-01", join(specDir, "TC-01.spec.ts")]]),
      executor: inProcess,
      retries: 0,
    });
    expect(results.get("TC-01")?.attempts).toEqual([
      expect.objectContaining({ outcome: "error", error: "login failed: 401" }),
    ]);
  });
});
