import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { CaseResultFileSchema, PlanSchema, createEventLog } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { executeAttempt } from "./attempt.js";
import { runCases } from "./run-cases.js";
import type { AttemptExecutor } from "./sandbox.js";
import { createPlaywrightTransport } from "./transport.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-16",
  version: 1,
  ...JSON.parse(
    readFileSync(new URL("../../../../fixtures/plans/demo-16-draft.json", import.meta.url), "utf8"),
  ),
});
const specDir = fileURLToPath(new URL("../../../../fixtures/specs/demo-16/", import.meta.url));
const PASSWORD = "fictional-demo-password";

const inProcess: AttemptExecutor = async (input) => {
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    return await executeAttempt(input, transport);
  } finally {
    await dispose();
  }
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const runDemo16 = async (flag?: string) => {
  const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) } });
  const run = await mkdtemp(join(tmpdir(), "qj-documents-"));
  cleanups.push(
    () => shop.close(),
    () => rm(run, { recursive: true, force: true }),
  );
  const tokens: string[] = [];
  const results = await runCases({
    plan,
    evidence: createLocalEvidenceStore(join(run, "evidence")),
    resultsDir: join(run, "results"),
    baseUrl: shop.url,
    allowedOrigins: [shop.url],
    login: async () => {
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
    },
    events: createEventLog({
      ticket: "DEMO-16",
      run: "r",
      write: () => undefined,
      now: () => new Date(0),
      mask: (v) => v,
    }),
    now: () => new Date(0),
    specs: new Map([
      ["TC-01", join(specDir, "TC-01.spec.ts")],
      ["TC-02", join(specDir, "TC-02.spec.ts")],
      ["TC-03", join(specDir, "TC-03.spec.ts")],
    ]),
    executor: inProcess,
  });
  return { run, results, tokens };
};

describe("multipart upload, file download and waiting against the demo shop (REQ-EXEC-45, REQ-EXEC-46, BUG-21)", () => {
  it("REQ-EXEC-45/AC1+AC2+AC3 + REQ-EXEC-46/AC1+AC2: the PDF is uploaded as multipart and comes back as a file kept by hash; a text file is refused", async () => {
    const { run, results, tokens } = await runDemo16();
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    expect(results.get("TC-02")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    // REQ-EXEC-46/AC1+AC2: the processing document is polled until ready; the rounds are evidence.
    expect(results.get("TC-03")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    const waited = CaseResultFileSchema.parse(
      JSON.parse(await readFile(join(run, "results", "TC-03.json"), "utf8")),
    );
    const s2 = waited.attempts[0]?.steps.find((x) => x.id === "S2");
    expect(s2?.wait?.met).toBe(true);
    expect(s2?.wait?.rounds).toBeGreaterThan(1);
    expect(s2?.wait?.waitedMs).toBeGreaterThanOrEqual(1000);
    expect(waited.attempts[0]?.evidence).toContain("TC-03/attempt-1/S2-wait.json");
    const file = CaseResultFileSchema.parse(
      JSON.parse(await readFile(join(run, "results", "TC-01.json"), "utf8")),
    );
    expect(file.attempts[0]?.evidence).toEqual(
      expect.arrayContaining([
        "TC-01/attempt-1/S1-upload-invoice.pdf",
        "TC-01/attempt-1/S2-download-invoice.pdf",
      ]),
    );
    const download = await readFile(join(run, "evidence", "TC-01/attempt-1/S2-download-invoice.pdf"));
    expect(download.byteLength).toBe(2048);
    const call = await readFile(join(run, "evidence", "TC-01/attempt-1/S2-01.json"), "utf8");
    expect(call).toContain('"file": "S2-download-invoice.pdf"');
    expect(call).not.toContain("qqqq");
    for (const token of tokens) expect(call).not.toContain(token);
  });

  it("BUG-21: a download one byte short fails the case, never passes it", async () => {
    const { results } = await runDemo16("BUG_DOCUMENT_TRUNCATED");
    // Every attempt fails, the retry included: a FAILED never turns into a pass.
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["failed", "failed"]);
    expect(results.get("TC-02")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
  });
});
