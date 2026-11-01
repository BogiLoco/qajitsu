import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import {
  PlanSchema,
  createEventLog,
  parseEventLines,
  type TestDataProvider,
  type TestDataRecord,
} from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { runCases } from "./run-cases.js";
import type { AttemptExecutor } from "./sandbox.js";

const TOKEN = "admin-token-123456";
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-17",
  version: 1,
  summary: "Low stock badge.",
  cases: [
    {
      id: "TC-01",
      title: "Three left is low stock",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      test_data: [
        { name: "lamp", kind: "product", with: { name: "Lamp", stock: 3, note: TOKEN } },
        { name: "shelf", kind: "product", with: { name: "Shelf", stock: 9 } },
      ],
      steps: [{ id: "S1", action: "GET /products/{id}", expect: { description: "Low stock", status: 200 } }],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A provider that keeps what exists, in order, and can be told to fail. */
const fakeProvider = (fail: { create?: string; remove?: boolean } = {}) => {
  const existing = new Map<string, TestDataRecord>();
  const log: string[] = [];
  let seq = 0;
  const provider: TestDataProvider = {
    create: (r) => {
      log.push(`create ${r.name} ${r.marker}`);
      if (fail.create === r.name)
        return Promise.reject(new Error(`POST /admin/products answered 500 for ${TOKEN}`));
      seq += 1;
      const rec: TestDataRecord = {
        name: r.name,
        kind: r.kind,
        id: `P-${String(seq)}`,
        record: { id: `P-${String(seq)}`, ...r.with },
      };
      existing.set(rec.id, rec);
      return Promise.resolve(rec);
    },
    remove: (rec, marker) => {
      log.push(`remove ${rec.name} ${marker}`);
      if (fail.remove) return Promise.reject(new Error("DELETE answered 503"));
      existing.delete(rec.id);
      return Promise.resolve();
    },
    cleanup: () => Promise.resolve(0),
  };
  return { provider, existing, log };
};

const run = async (
  provider: TestDataProvider,
  options: { keep?: boolean; outcome?: "passed" | "failed" } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "qj-test-data-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const seen: unknown[] = [];
  const executor: AttemptExecutor = (input) => {
    seen.push(input.testData);
    return Promise.resolve({
      caseId: input.caseId,
      attempt: input.attempt,
      outcome: options.outcome ?? "passed",
      steps: [{ id: "S1", ok: true }],
      assertions: [
        { stepId: "S1", field: "status", expected: 200, actual: 200, pass: options.outcome !== "failed" },
      ],
      evidence: [],
    });
  };
  const results = await runCases({
    plan,
    specs: new Map([["TC-01", join(dir, "TC-01.spec.ts")]]),
    executor,
    evidence: createLocalEvidenceStore(join(dir, "evidence")),
    resultsDir: join(dir, "results"),
    baseUrl: "http://127.0.0.1:3000",
    allowedOrigins: ["http://127.0.0.1:3000"],
    login: () => Promise.resolve({ accounts: {}, secrets: [TOKEN] }),
    events: createEventLog({
      ticket: "DEMO-17",
      run: "r",
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    }),
    now: () => new Date(0),
    retries: options.outcome === "failed" ? 1 : 0,
    testData: provider,
    marker: "qj-DEMO-17-20261030-1200-abcd",
    ...(options.keep ? { keepTestData: true } : {}),
  });
  return { dir, results, seen, events: parseEventLines(lines.join("")).events };
};

describe("test data per case (REQ-EXEC-53)", () => {
  it("REQ-EXEC-53/AC1+AC2+AC4: records are created with a marker per attempt before the case, given to the spec, removed after it, and evidence", async () => {
    const { provider, existing, log } = fakeProvider();
    const { dir, results, seen } = await run(provider);
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    const marker = "qj-DEMO-17-20261030-1200-abcd-TC-01-a1";
    expect(log).toEqual([
      `create lamp ${marker}`,
      `create shelf ${marker}`,
      // Removed in reverse order, so a record that depends on an earlier one goes first.
      `remove shelf ${marker}`,
      `remove lamp ${marker}`,
    ]);
    expect(existing.size).toBe(0);
    expect(seen[0]).toEqual({
      lamp: { id: "P-1", name: "Lamp", stock: 3, note: TOKEN },
      shelf: { id: "P-2", name: "Shelf", stock: 9 },
    });
    const evidence = await readFile(join(dir, "evidence", "TC-01/attempt-1/test-data.json"), "utf8");
    expect(JSON.parse(evidence)).toEqual({
      marker,
      created: [
        {
          name: "lamp",
          kind: "product",
          id: "P-1",
          record: { id: "P-1", name: "Lamp", stock: 3, note: "***" },
        },
        { name: "shelf", kind: "product", id: "P-2", record: { id: "P-2", name: "Shelf", stock: 9 } },
      ],
      removed: ["shelf", "lamp"],
      kept: [],
    });
  });

  it("REQ-EXEC-53/AC2: every attempt gets its own records under its own marker", async () => {
    const { provider, log } = fakeProvider();
    const { results } = await run(provider, { outcome: "failed" });
    expect(results.get("TC-01")?.attempts).toHaveLength(2);
    expect(log.filter((l) => l.startsWith("create lamp")).map((l) => l.split(" ")[2])).toEqual([
      "qj-DEMO-17-20261030-1200-abcd-TC-01-a1",
      "qj-DEMO-17-20261030-1200-abcd-TC-01-a2",
    ]);
  });

  it("REQ-EXEC-53/AC3: data that cannot be created makes the attempt BLOCKED before any step; what was made is removed", async () => {
    const { provider, existing, log } = fakeProvider({ create: "shelf" });
    const { results, seen } = await run(provider);
    const attempt = results.get("TC-01")?.attempts[0];
    expect(attempt?.outcome).toBe("error");
    expect(attempt?.error).toBe(
      "test data shelf (product) could not be created: POST /admin/products answered 500 for ***",
    );
    expect(attempt?.steps).toEqual([]);
    expect(seen).toEqual([]);
    expect(log.at(-1)).toBe("remove lamp qj-DEMO-17-20261030-1200-abcd-TC-01-a1");
    expect(existing.size).toBe(0);
  });

  it("REQ-EXEC-53/AC1: a run that keeps its data for debugging leaves the records and says so; a failed removal is a warning", async () => {
    const kept = fakeProvider();
    const { dir } = await run(kept.provider, { keep: true });
    expect(kept.existing.size).toBe(2);
    const evidence = JSON.parse(
      await readFile(join(dir, "evidence", "TC-01/attempt-1/test-data.json"), "utf8"),
    ) as {
      kept: string[];
    };
    expect(evidence.kept).toEqual(["lamp", "shelf"]);
    const broken = fakeProvider({ remove: true });
    const { results, events } = await run(broken.provider);
    expect(results.get("TC-01")?.attempts[0]?.outcome).toBe("passed");
    expect(
      events
        .filter((e) => e.event === "test_data.remove_failed")
        .map((e) => (e.details as { name: string }).name),
    ).toEqual(["shelf", "lamp"]);
  });
});
